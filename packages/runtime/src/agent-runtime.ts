import type { DevicePort, LlmConversationItem, LlmPort, LoggerPort, PermissionPort, SessionStorePort, WaveformLibraryPort } from '@dg-agent/contracts';
import { createEmptyDeviceState, createMessage, type ActionContext, type SessionSnapshot } from '@dg-agent/core';
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
import { RuntimeToolExecutor } from './runtime-tool-executor.js';
import { resolveToolCallConfig, type ToolCallConfig, type ToolCallConfigInput } from './tool-call-config.js';
import {
  buildConversationItems,
  collectTurnToolCalls,
  createTurnState,
  safeStringify,
  type TurnToolCallSummary,
} from './runtime-turn-state.js';
import { createDefaultToolRegistryWithDeps, ToolRegistry } from './tool-registry.js';

export interface AgentRuntimeOptions {
  device: DevicePort;
  llm: LlmPort;
  permission: PermissionPort;
  buildInstructions?: (input: {
    session: SessionSnapshot;
    context: ActionContext;
    isFirstIteration: boolean;
    turnToolCalls: readonly TurnToolCallSummary[];
  }) => string;
  waveformLibrary?: WaveformLibraryPort;
  sessionStore?: SessionStorePort;
  logger?: LoggerPort;
  toolRegistry?: ToolRegistry;
  policyEngine?: PolicyEngine;
  toolCallConfig?: ToolCallConfigInput;
}

export interface SendUserMessageInput {
  sessionId: string;
  text: string;
  context: ActionContext;
}

export type { TurnToolCallSummary } from './runtime-turn-state.js';

const defaultLogger: LoggerPort = {
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
  private readonly sessions: SessionStorePort;
  private readonly queue: DeviceCommandQueue;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolCallConfig: ToolCallConfig;
  private readonly toolExecutor: RuntimeToolExecutor;
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly pendingFollowUps = new Map<string, SendUserMessageInput[]>();

  constructor(private readonly options: AgentRuntimeOptions) {
    this.sessions = options.sessionStore ?? new InMemorySessionStore();
    this.queue = new DeviceCommandQueue(options.device);
    this.toolRegistry =
      options.toolRegistry ?? createDefaultToolRegistryWithDeps({ waveformLibrary: options.waveformLibrary });
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
      sendUserMessage: (input) => this.sendUserMessage(input),
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

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = await this.ensureSession(sessionId);
    const currentDeviceState = await this.options.device.getState();

    if (JSON.stringify(session.deviceState) !== JSON.stringify(currentDeviceState)) {
      session.deviceState = currentDeviceState;
      session.updatedAt = Date.now();
      await this.sessions.save(session);
    }

    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.abortCurrentReply(sessionId);
    this.toolExecutor.cancelScheduledTimers(sessionId);
    await this.sessions.delete(sessionId);
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
    if (this.activeTurns.has(input.sessionId)) {
      if (input.context.sourceType === 'system') {
        this.enqueueFollowUp(input);
        return;
      }
      throw new Error('Another reply is already in progress for this session.');
    }

    const session = await this.ensureSession(input.sessionId);
    const userMessage = createMessage('user', input.text);
    const abortController = new AbortController();

    session.messages.push(userMessage);
    session.updatedAt = Date.now();
    await this.sessions.save(session);

    this.events.emit({
      type: 'user-message-accepted',
      sessionId: session.id,
      message: userMessage,
    });

    this.activeTurns.set(session.id, abortController);

    try {
      const turnResult = await this.runToolLoop(session, input, abortController.signal);
      throwIfAborted(abortController.signal);

      const assistantMessage = createMessage('assistant', turnResult.finalAssistantText);
      session.messages.push(assistantMessage);
      session.updatedAt = Date.now();
      session.deviceState = await this.options.device.getState();
      await this.sessions.save(session);

      this.events.emit({
        type: 'assistant-message-completed',
        sessionId: session.id,
        message: assistantMessage,
      });
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        const abortedMessage = createMessage('assistant', REPLY_ABORTED_NOTE);
        session.messages.push(abortedMessage);
        session.updatedAt = Date.now();
        session.deviceState = await this.options.device.getState();
        await this.sessions.save(session);

        this.events.emit({
          type: 'assistant-message-aborted',
          sessionId: session.id,
          reason: REPLY_ABORTED_ERROR_MESSAGE,
          message: abortedMessage,
        });
        throw new Error(REPLY_ABORTED_ERROR_MESSAGE);
      }

      const assistantErrorMessage = createMessage('assistant', normalizeAssistantErrorMessage(error));
      session.messages.push(assistantErrorMessage);
      session.updatedAt = Date.now();
      session.deviceState = await this.options.device.getState();
      await this.sessions.save(session);

      this.events.emit({
        type: 'runtime-warning',
        sessionId: session.id,
        message: assistantErrorMessage.content,
      });
      this.events.emit({
        type: 'assistant-message-completed',
        sessionId: session.id,
        message: assistantErrorMessage,
      });
    } finally {
      if (this.activeTurns.get(session.id) === abortController) {
        this.activeTurns.delete(session.id);
      }
      queueMicrotask(() => {
        void this.drainPendingFollowUps(session.id);
      });
    }
  }

  private async runToolLoop(
    session: SessionSnapshot,
    input: SendUserMessageInput,
    abortSignal?: AbortSignal,
  ): Promise<{ finalAssistantText: string }> {
    const turnState = createTurnState();

    for (let iteration = 0; iteration < this.toolCallConfig.maxToolIterations; iteration++) {
      throwIfAborted(abortSignal);

      const llmResult = await this.options.llm.runTurn({
        session,
        message: input.text,
        context: input.context,
        instructions:
          this.options.buildInstructions?.({
            session,
            context: input.context,
            isFirstIteration: iteration === 0,
            turnToolCalls: collectTurnToolCalls(turnState),
          }) ?? '',
        tools: await this.toolRegistry.listDefinitions(),
        conversation: buildConversationItems(session, turnState),
        abortSignal,
        onTextDelta: (content) => {
          this.events.emit({
            type: 'assistant-message-delta',
            sessionId: session.id,
            content,
          });
        },
      });

      throwIfAborted(abortSignal);

      if ((llmResult.toolCalls ?? []).length === 0) {
        return {
          finalAssistantText: llmResult.assistantMessage,
        };
      }

      const iterationItems: LlmConversationItem[] = [];
      const iterationAssistantMessage = llmResult.assistantMessage.trim();

      if (iterationAssistantMessage) {
        const assistantMessage = createMessage('assistant', iterationAssistantMessage);
        session.messages.push(assistantMessage);
        session.updatedAt = Date.now();
        await this.sessions.save(session);
        this.events.emit({
          type: 'session-updated',
          sessionId: session.id,
        });
      }

      for (const toolCall of llmResult.toolCalls ?? []) {
        iterationItems.push({
          kind: 'function_call',
          callId: toolCall.id,
          name: toolCall.name,
          argumentsJson: safeStringify(toolCall.args),
        });

        const output = await this.toolExecutor.execute({
          session,
          toolCall,
          context: input.context,
          turnState,
          abortSignal,
        });
        if (shouldStopTurnForDisconnectedDevice(toolCall.name, output)) {
          return {
            finalAssistantText: '设备未连接，请先点击“连接设备”。',
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

  private async ensureSession(sessionId: string): Promise<SessionSnapshot> {
    const existing = await this.sessions.get(sessionId);
    if (existing) {
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

    await this.sessions.save(created);
    return created;
  }

  private enqueueFollowUp(input: SendUserMessageInput): void {
    const queue = this.pendingFollowUps.get(input.sessionId) ?? [];
    queue.push(input);
    this.pendingFollowUps.set(input.sessionId, queue);
  }

  private async drainPendingFollowUps(sessionId: string): Promise<void> {
    if (this.activeTurns.has(sessionId)) return;

    const queue = this.pendingFollowUps.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift();
    if (!next) return;
    if (queue.length === 0) {
      this.pendingFollowUps.delete(sessionId);
    } else {
      this.pendingFollowUps.set(sessionId, queue);
    }

    await this.sendUserMessage(next);
  }
}

function shouldStopTurnForDisconnectedDevice(toolName: string, output: string): boolean {
  if (!isDeviceToolName(toolName)) return false;

  try {
    const parsed = JSON.parse(output) as { error?: string };
    return parsed.error === '设备未连接。';
  } catch {
    return false;
  }
}

function isDeviceToolName(name: string): boolean {
  return (
    name === 'start' ||
    name === 'stop' ||
    name === 'adjust_strength' ||
    name === 'change_wave' ||
    name === 'burst' ||
    name === 'emergency_stop'
  );
}
