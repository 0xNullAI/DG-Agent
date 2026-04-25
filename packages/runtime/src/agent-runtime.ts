import type {
  DeviceClient,
  LlmConversationItem,
  LlmClient,
  Logger,
  PermissionService,
  SessionStore,
  SessionTraceStore,
  WaveformLibrary,
} from '@dg-agent/core';
import {
  createEmptyDeviceState,
  createMessage,
  isDeviceToolName,
  mergeBridgeOriginMetadata,
  type ActionContext,
  type ConversationMessage,
  type ModelContextStrategy,
  type RuntimeTraceEntry,
  type SessionSnapshot,
} from '@dg-agent/core';
import { createDefaultPolicyRules } from './default-policies.js';
import { DeviceCommandQueue } from './device-command-queue.js';
import { InMemoryEventBus, type RuntimeListener } from './event-bus.js';
import { InMemorySessionStore } from './in-memory-session-store.js';
import { PolicyEngine } from './policy-engine.js';
import {
  isAbortError,
  normalizeAssistantErrorMessage,
  REPLY_ABORTED_ERROR_MESSAGE,
  REPLY_ABORTED_NOTE,
  throwIfAborted,
  TOOL_LOOP_EXHAUSTED_MESSAGE,
} from './runtime-errors.js';
import { RuntimeToolExecutor, type TimerFiredTrigger } from './runtime-tool-executor.js';
import {
  resolveToolCallConfig,
  type ToolCallConfig,
  type ToolCallConfigInput,
} from './tool-call-config.js';
import {
  buildConversationItems,
  collectTurnToolCalls,
  createTurnState,
  type TurnState,
  type TurnToolCallSummary,
} from './runtime-turn-state.js';
import { InMemorySessionTraceStore } from './session-trace.js';
import {
  normalizeSessionHistory,
  appendAssistantMessage,
  appendSkippedToolOutputs,
} from './session-history.js';
import { createDefaultToolRegistryWithDeps } from './tool-registry.js';
import type { ToolRegistry } from './tool-registry.js';

export interface AgentRuntimeOptions {
  device: DeviceClient;
  llm: LlmClient;
  permission: PermissionService;
  buildInstructions?: (input: {
    session: SessionSnapshot;
    context: ActionContext;
    isFirstIteration: boolean;
    turnToolCalls: readonly TurnToolCallSummary[];
  }) => string;
  waveformLibrary?: WaveformLibrary;
  sessionStore?: SessionStore;
  sessionTraceStore?: SessionTraceStore;
  logger?: Logger;
  toolRegistry?: ToolRegistry;
  policyEngine?: PolicyEngine;
  toolCallConfig?: ToolCallConfigInput;
  modelContextStrategy?: ModelContextStrategy;
}

export interface SendUserMessageInput {
  sessionId: string;
  text: string;
  context: ActionContext;
  persistMessage?: boolean;
}

export type { TurnToolCallSummary } from './runtime-turn-state.js';

const defaultLogger: Logger = {
  info(message, meta) {
    console.log(message, meta ?? {});
  },
  warn(message, meta) {
    console.warn(message, meta ?? {});
  },
  error(message, meta) {
    console.error(message, meta ?? {});
  },
};

export class AgentRuntime {
  private readonly events = new InMemoryEventBus();
  private readonly sessions: SessionStore;
  private readonly traces: SessionTraceStore;
  private readonly queue: DeviceCommandQueue;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolCallConfig: ToolCallConfig;
  private readonly toolExecutor: RuntimeToolExecutor;
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly pendingSystemWork = new Map<string, QueuedSystemWork[]>();
  private readonly drainingSessions = new Set<string>();
  private readonly deletedSessionIds = new Set<string>();

  constructor(private readonly options: AgentRuntimeOptions) {
    this.sessions = options.sessionStore ?? new InMemorySessionStore();
    this.traces = options.sessionTraceStore ?? new InMemorySessionTraceStore();
    this.queue = new DeviceCommandQueue(options.device);
    this.toolRegistry =
      options.toolRegistry ??
      createDefaultToolRegistryWithDeps({ waveformLibrary: options.waveformLibrary });
    this.toolCallConfig = resolveToolCallConfig(options.toolCallConfig);

    const policyEngine = options.policyEngine ?? new PolicyEngine(createDefaultPolicyRules());
    const logger = options.logger ?? defaultLogger;
    this.toolExecutor = new RuntimeToolExecutor({
      device: options.device,
      permission: options.permission,
      queue: this.queue,
      toolRegistry: this.toolRegistry,
      policyEngine,
      logger,
      toolCallConfig: this.toolCallConfig,
      emit: (event) => {
        this.events.emit(event);
      },
      enqueueTimerTrigger: (trigger) =>
        this.enqueueSystemWork(trigger.sessionId, { kind: 'timer-fired', trigger }),
      traceStore: this.traces,
    });

    options.device.onStateChanged((state) => {
      this.events.emit({ type: 'device-state-changed', state });
    });
  }

  subscribe(listener: RuntimeListener): () => void {
    return this.events.subscribe(listener);
  }

  async listSessions(): Promise<SessionSnapshot[]> {
    return this.sessions.list();
  }

  async getSessionTrace(sessionId: string): Promise<RuntimeTraceEntry[]> {
    if (this.isSessionDeleted(sessionId)) {
      return [];
    }
    const existing = await this.sessions.get(sessionId);
    if (!existing) {
      return [];
    }
    return this.traces.list(sessionId);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = await this.ensureSession(sessionId);
    const currentDeviceState = await this.options.device.getState();

    if (JSON.stringify(session.deviceState) !== JSON.stringify(currentDeviceState)) {
      const refreshedSession: SessionSnapshot = {
        ...session,
        deviceState: currentDeviceState,
        updatedAt: Date.now(),
      };
      if (!this.activeTurns.has(sessionId)) {
        await this.sessions.save(refreshedSession);
      }
      return refreshedSession;
    }

    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessionIds.add(sessionId);
    await this.abortCurrentReply(sessionId);
    this.toolExecutor.cancelScheduledTimers(sessionId);
    this.pendingSystemWork.delete(sessionId);
    this.drainingSessions.delete(sessionId);
    await this.sessions.delete(sessionId);
    await this.traces.clear(sessionId);
  }

  async connectDevice(): Promise<void> {
    await this.options.device.connect();
  }

  async disconnectDevice(): Promise<void> {
    await this.options.device.disconnect();
  }

  async emergencyStop(sessionId: string): Promise<void> {
    this.toolExecutor.cancelScheduledTimers(sessionId);
    const result = await this.queue.enqueue({ type: 'emergencyStop' });
    this.events.emit({
      type: 'device-command-executed',
      sessionId,
      command: { type: 'emergencyStop' },
      result,
    });
  }

  async abortCurrentReply(sessionId: string): Promise<void> {
    this.activeTurns.get(sessionId)?.abort();
  }

  async sendUserMessage(input: SendUserMessageInput): Promise<void> {
    if (this.isSessionDeleted(input.sessionId)) {
      if (input.context.sourceType === 'system') {
        return;
      }
      this.deletedSessionIds.delete(input.sessionId);
    }

    if (this.activeTurns.has(input.sessionId)) {
      if (input.context.sourceType === 'system') {
        this.enqueueSystemWork(input.sessionId, { kind: 'follow-up', input });
        return;
      }
      throw new Error('当前会话已有回复正在进行中');
    }

    const session = await this.ensureSession(input.sessionId);
    session.metadata = mergeBridgeOriginMetadata(session.metadata, input.context);
    const persistIncomingMessage = input.persistMessage ?? input.context.sourceType !== 'system';
    const incomingMessage = persistIncomingMessage ? createIncomingMessage(input) : null;
    const abortController = new AbortController();
    const ephemeralInput = persistIncomingMessage
      ? null
      : ({
          kind: 'message',
          role: 'user',
          content: input.text,
        } satisfies LlmConversationItem);

    let turnStartIndex = session.messages.length - 1;
    if (incomingMessage) {
      session.messages.push(incomingMessage);
      turnStartIndex = session.messages.length - 1;
      session.updatedAt = Date.now();
      await this.saveSessionIfAvailable(session);

      this.events.emit({
        type: 'user-message-accepted',
        sessionId: session.id,
        message: incomingMessage,
        sourceType: input.context.sourceType,
      });
    }

    this.activeTurns.set(session.id, abortController);

    try {
      const turnResult = await this.runToolLoop(
        session,
        input,
        turnStartIndex,
        ephemeralInput,
        abortController.signal,
      );
      throwIfAborted(abortController.signal);

      const assistantMessage = appendAssistantMessage(
        session,
        { content: turnResult.finalAssistantText },
        turnStartIndex,
      );
      session.updatedAt = Date.now();
      session.deviceState = await this.options.device.getState();
      await this.saveSessionIfAvailable(session);

      this.events.emit({
        type: 'assistant-message-completed',
        sessionId: session.id,
        message: assistantMessage,
        sourceType: input.context.sourceType,
      });
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        const abortedMessage = appendAssistantMessage(
          session,
          { content: REPLY_ABORTED_NOTE },
          turnStartIndex,
        );
        session.updatedAt = Date.now();
        session.deviceState = await this.options.device.getState();
        await this.saveSessionIfAvailable(session);

        this.events.emit({
          type: 'assistant-message-aborted',
          sessionId: session.id,
          reason: REPLY_ABORTED_ERROR_MESSAGE,
          message: abortedMessage,
          sourceType: input.context.sourceType,
        });
        throw new Error(REPLY_ABORTED_ERROR_MESSAGE);
      }

      const assistantErrorMessage = appendAssistantMessage(
        session,
        { content: normalizeAssistantErrorMessage(error) },
        turnStartIndex,
      );
      session.updatedAt = Date.now();
      session.deviceState = await this.options.device.getState();
      await this.saveSessionIfAvailable(session);

      this.events.emit({
        type: 'runtime-warning',
        sessionId: session.id,
        message: assistantErrorMessage.content,
      });
      this.events.emit({
        type: 'assistant-message-completed',
        sessionId: session.id,
        message: assistantErrorMessage,
        sourceType: input.context.sourceType,
      });
    } finally {
      if (this.activeTurns.get(session.id) === abortController) {
        this.activeTurns.delete(session.id);
      }
      queueMicrotask(() => {
        void this.drainSystemWork(session.id);
      });
    }
  }

  private async runToolLoop(
    session: SessionSnapshot,
    input: SendUserMessageInput,
    turnStartIndex: number,
    ephemeralInput: LlmConversationItem | null,
    abortSignal?: AbortSignal,
  ): Promise<{ finalAssistantText: string }> {
    const turnState = createTurnState();

    for (let iteration = 0; iteration < this.toolCallConfig.maxToolIterations; iteration++) {
      throwIfAborted(abortSignal);

      session.deviceState = await this.options.device.getState();

      const instructions =
        this.options.buildInstructions?.({
          session,
          context: input.context,
          isFirstIteration: iteration === 0,
          turnToolCalls: collectTurnToolCalls(turnState),
        }) ?? '';
      const tools =
        input.context.sourceType === 'system' ? [] : await this.toolRegistry.listDefinitions();
      const conversation = buildConversationItems(
        session,
        turnState,
        iteration === 0 ? ephemeralInput : null,
        this.options.modelContextStrategy,
      );

      const messageSummary = conversation.map((item) => ({
        role:
          item.kind === 'message'
            ? item.role
            : item.kind === 'function_call'
              ? 'tool_call'
              : 'tool_result',
        content:
          item.kind === 'message'
            ? item.content
            : item.kind === 'function_call'
              ? `${item.name}(${item.argumentsJson})`
              : item.output,
        toolCallCount:
          item.kind === 'message' && item.toolCalls?.length ? item.toolCalls.length : undefined,
      }));

      this.events.emit({
        type: 'llm-turn-start',
        sessionId: session.id,
        iteration,
        instructions,
        messages: messageSummary,
        toolNames: tools.map((t) => t.name),
      });

      let capturedRequest: unknown;

      const llmResult = await this.options.llm.runTurn({
        session,
        message: input.text,
        context: input.context,
        instructions,
        tools,
        conversation,
        abortSignal,
        onTextDelta: (content) => {
          this.events.emit({
            type: 'assistant-message-delta',
            sessionId: session.id,
            content,
          });
        },
        onRawRequest: (body) => {
          capturedRequest = body;
        },
      });

      this.events.emit({
        type: 'llm-turn-complete',
        sessionId: session.id,
        iteration,
        assistantMessage: llmResult.assistantMessage,
        toolCalls: llmResult.toolCalls ?? [],
        rawRequest: capturedRequest,
        rawResponse: llmResult.rawResponse,
      });

      throwIfAborted(abortSignal);

      if ((llmResult.toolCalls ?? []).length === 0) {
        return {
          finalAssistantText: llmResult.assistantMessage,
        };
      }

      const iterationItems: LlmConversationItem[] = [];
      const iterationAssistantContent = llmResult.assistantMessage;
      const iterationHasAssistantState =
        iterationAssistantContent.trim().length > 0 ||
        (llmResult.reasoningContent?.trim().length ?? 0) > 0 ||
        (llmResult.toolCalls?.length ?? 0) > 0;

      if (iterationHasAssistantState) {
        appendAssistantMessage(
          session,
          {
            content: iterationAssistantContent,
            reasoningContent: llmResult.reasoningContent,
            toolCalls: llmResult.toolCalls,
          },
          turnStartIndex,
        );
        iterationItems.push({
          kind: 'message',
          role: 'assistant',
          content: iterationAssistantContent,
          reasoningContent: llmResult.reasoningContent,
          toolCalls: llmResult.toolCalls,
        });
        session.updatedAt = Date.now();
        await this.saveSessionIfAvailable(session);
        this.events.emit({
          type: 'session-updated',
          sessionId: session.id,
        });
      }

      const toolCalls = llmResult.toolCalls ?? [];
      for (let index = 0; index < toolCalls.length; index += 1) {
        const toolCall = toolCalls[index];
        if (!toolCall) continue;
        const output = await this.toolExecutor.execute({
          session,
          toolCall,
          context: input.context,
          turnState,
          abortSignal,
        });
        const deniedTrigger = getEphemeralDeniedTrigger(toolCall, output);
        if (deniedTrigger) {
          iterationItems.push({
            kind: 'function_call_output',
            callId: toolCall.id,
            output,
          });
          appendSkippedToolOutputs(
            iterationItems,
            toolCalls.slice(index + 1),
            'Skipped after an earlier tool call was denied.',
          );
          turnState.workingItems.push(...iterationItems);
          return this.runEphemeralNoToolFollowUp(
            session,
            input,
            turnState,
            deniedTrigger,
            abortSignal,
          );
        }
        if (shouldStopTurnForDisconnectedDevice(toolCall.name, output)) {
          iterationItems.push({
            kind: 'function_call_output',
            callId: toolCall.id,
            output,
          });
          appendSkippedToolOutputs(
            iterationItems,
            toolCalls.slice(index + 1),
            'Skipped because the device is not connected.',
          );
          turnState.workingItems.push(...iterationItems);
          return {
            finalAssistantText: '设备未连接，请先点击“连接设备”',
          };
        }

        iterationItems.push({
          kind: 'function_call_output',
          callId: toolCall.id,
          output,
        });
      }

      turnState.workingItems.push(...iterationItems);
    }

    return {
      finalAssistantText: TOOL_LOOP_EXHAUSTED_MESSAGE,
    };
  }

  private async runEphemeralNoToolFollowUp(
    session: SessionSnapshot,
    input: SendUserMessageInput,
    turnState: TurnState,
    triggerText: string,
    abortSignal?: AbortSignal,
  ): Promise<{ finalAssistantText: string }> {
    const llmResult = await this.options.llm.runTurn({
      session,
      message: triggerText,
      context: input.context,
      instructions:
        this.options.buildInstructions?.({
          session,
          context: input.context,
          isFirstIteration: false,
          turnToolCalls: collectTurnToolCalls(turnState),
        }) ?? '',
      tools: [],
      conversation: buildConversationItems(
        session,
        turnState,
        {
          kind: 'message',
          role: 'user',
          content: triggerText,
        },
        this.options.modelContextStrategy,
      ),
      abortSignal,
      onTextDelta: (content) => {
        this.events.emit({
          type: 'assistant-message-delta',
          sessionId: session.id,
          content,
        });
      },
    });

    return {
      finalAssistantText: llmResult.assistantMessage,
    };
  }

  private async processTimerTrigger(trigger: TimerFiredTrigger): Promise<void> {
    if (this.isSessionDeleted(trigger.sessionId)) {
      return;
    }
    await this.ensureSession(trigger.sessionId);
    await this.traces.append(trigger.sessionId, {
      kind: 'timer-fired',
      turnId: `timer-${trigger.firedAt}`,
      sourceType: 'system',
      synthetic: true,
      label: trigger.label,
      seconds: trigger.seconds,
      firedAt: trigger.firedAt,
    });

    await this.sendUserMessage({
      sessionId: trigger.sessionId,
      text: buildTimerTriggerPrompt(trigger),
      context: {
        sessionId: trigger.sessionId,
        sourceType: 'system',
        traceId: `timer-${trigger.firedAt}`,
      },
      persistMessage: false,
    });
  }

  private async ensureSession(sessionId: string): Promise<SessionSnapshot> {
    const existing = await this.sessions.get(sessionId);
    if (existing) {
      if (normalizeSessionHistory(existing)) {
        await this.saveSessionIfAvailable(existing);
      }
      return existing;
    }

    const now = Date.now();
    const created: SessionSnapshot = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      deviceState: createEmptyDeviceState(),
    };

    await this.saveSessionIfAvailable(created);
    return created;
  }

  private enqueueSystemWork(sessionId: string, work: QueuedSystemWork): void {
    const queue = this.pendingSystemWork.get(sessionId) ?? [];
    queue.push(work);
    this.pendingSystemWork.set(sessionId, queue);
    queueMicrotask(() => {
      void this.drainSystemWork(sessionId);
    });
  }

  private async drainSystemWork(sessionId: string): Promise<void> {
    if (
      this.activeTurns.has(sessionId) ||
      this.drainingSessions.has(sessionId) ||
      this.isSessionDeleted(sessionId)
    )
      return;

    const queue = this.pendingSystemWork.get(sessionId);
    if (!queue || queue.length === 0) return;

    this.drainingSessions.add(sessionId);
    try {
      while (!this.activeTurns.has(sessionId)) {
        if (this.isSessionDeleted(sessionId)) {
          this.pendingSystemWork.delete(sessionId);
          break;
        }
        const currentQueue = this.pendingSystemWork.get(sessionId);
        const next = currentQueue?.shift();
        if (!next) {
          this.pendingSystemWork.delete(sessionId);
          break;
        }
        if (!currentQueue || currentQueue.length === 0) {
          this.pendingSystemWork.delete(sessionId);
        } else {
          this.pendingSystemWork.set(sessionId, currentQueue);
        }

        if (next.kind === 'timer-fired') {
          await this.processTimerTrigger(next.trigger);
          continue;
        }

        await this.sendUserMessage(next.input);
      }
    } finally {
      this.drainingSessions.delete(sessionId);
    }
  }

  private async saveSessionIfAvailable(session: SessionSnapshot): Promise<void> {
    if (this.isSessionDeleted(session.id)) {
      return;
    }
    await this.sessions.save(session);
  }

  private isSessionDeleted(sessionId: string): boolean {
    return this.deletedSessionIds.has(sessionId);
  }
}

type QueuedSystemWork =
  | {
      kind: 'follow-up';
      input: SendUserMessageInput;
    }
  | {
      kind: 'timer-fired';
      trigger: TimerFiredTrigger;
    };

function createIncomingMessage(input: SendUserMessageInput): ConversationMessage {
  return createMessage('user', input.text);
}

function buildTimerTriggerPrompt(trigger: TimerFiredTrigger): string {
  return [
    `[内部提醒] 你之前设置的定时“${trigger.label}”已到期。`,
    '这不是用户的新消息，用户没有提供新的反馈。',
    '请基于当前设备状态和最近一轮对话做一次简短跟进，不要自动操作设备，也不要再次设置定时。',
  ].join('\n');
}

function getEphemeralDeniedTrigger(toolCall: { name: string }, output: string): string | null {
  try {
    const parsed = JSON.parse(output) as {
      error?: string;
      _meta?: { kind?: string };
    };
    const kind = parsed._meta?.kind;
    if ((kind !== 'tool-denied' && kind !== 'tool-failed') || !parsed.error) {
      return null;
    }
    if (parsed.error === '设备未连接') {
      return null;
    }

    return [
      `[内部提醒] 刚才请求的工具“${toolCall.name}”未执行。`,
      `原因：${parsed.error}`,
      kind === 'tool-failed'
        ? '请直接向用户解释执行失败的原因，不要再次调用工具，也不要假装已经成功。'
        : '请直接向用户解释这一步没有执行，不要再次调用工具，也不要假装已经成功。',
    ].join('\n');
  } catch {
    return null;
  }
}

function shouldStopTurnForDisconnectedDevice(toolName: string, output: string): boolean {
  if (!isDeviceToolName(toolName)) return false;

  try {
    const parsed = JSON.parse(output) as { error?: string };
    return parsed.error === '设备未连接';
  } catch {
    return false;
  }
}
