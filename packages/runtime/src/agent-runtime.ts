import type {
  DeviceClient,
  DeviceKind,
  LlmConversationItem,
  LlmClient,
  Logger,
  PermissionService,
  SensorState,
  SessionStore,
  SessionTraceStore,
  SourceType,
  WaveformLibrary,
} from '@dg-agent/core';
import type { OpossumState } from '@dg-kit/protocol';
import {
  createEmptyDeviceState,
  createMessage,
  isDeviceToolName,
  isSensorTriggersEnabled,
  mergeBridgeOriginMetadata,
  withSensorLastReading,
  withSensorTriggersEnabled,
  type ActionContext,
  type ConversationMessage,
  type ModelContextStrategy,
  type RuntimeTraceEntry,
  type SessionSnapshot,
} from '@dg-agent/core';
import { createDefaultOpossumPolicyRules, createDefaultPolicyRules } from './default-policies.js';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from './device-clients.js';
import { DeviceCommandQueue, OpossumCommandQueue } from './device-command-queue.js';
import { InMemoryEventBus, type RuntimeListener } from './event-bus.js';
import { InMemorySessionStore } from './in-memory-session-store.js';
import { OpossumPolicyEngine, PolicyEngine } from './policy-engine.js';
import {
  isAbortError,
  normalizeAssistantErrorMessage,
  REPLY_ABORTED_ERROR_MESSAGE,
  REPLY_ABORTED_NOTE,
  throwIfAborted,
  TOOL_LOOP_EXHAUSTED_MESSAGE,
} from './runtime-errors.js';
import {
  DEVICE_KIND_DISPLAY_NAME,
  filterToolDefinitionsByConnectedDevices,
  resolveRequiredDeviceKind,
  RuntimeToolExecutor,
  type TimerFiredTrigger,
} from './runtime-tool-executor.js';
import {
  SensorTriggerEngine,
  type SensorFiredTrigger,
  type SensorTriggerEngineOptions,
} from './sensor-trigger-engine.js';
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
  /** At most one connected Opossum vibration controller, alongside Coyote. */
  opossum?: OpossumClient;
  /** At most one connected paw-prints button/motion sensor, alongside Coyote. */
  pawPrints?: PawPrintsClient;
  /** At most one connected civet-edging pressure sensor, alongside Coyote. */
  civetEdging?: CivetEdgingClient;
  llm: LlmClient;
  permission: PermissionService;
  buildInstructions?: (input: {
    session: SessionSnapshot;
    context: ActionContext;
    isFirstIteration: boolean;
    turnToolCalls: readonly TurnToolCallSummary[];
    /** Present only when an Opossum client is configured, connected or not. */
    opossumState?: OpossumState;
    /** Present only when a paw-prints client is configured, connected or not. */
    pawPrintsState?: SensorState;
    /** Present only when a civet-edging client is configured, connected or not. */
    civetEdgingState?: SensorState;
  }) => string;
  waveformLibrary?: WaveformLibrary;
  sessionStore?: SessionStore;
  sessionTraceStore?: SessionTraceStore;
  logger?: Logger;
  toolRegistry?: ToolRegistry;
  policyEngine?: PolicyEngine;
  opossumPolicyEngine?: OpossumPolicyEngine;
  toolCallConfig?: ToolCallConfigInput;
  modelContextStrategy?: ModelContextStrategy;
  /** Thresholds for the Sensor Trigger Engine (see `setSensorTriggersEnabled`). */
  sensorTriggerOptions?: Pick<
    SensorTriggerEngineOptions,
    'civetPressureDeltaThresholdKPa' | 'debounceMs' | 'now'
  >;
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
  private readonly disposeDeviceListener: () => void;
  private readonly opossumQueue?: OpossumCommandQueue;
  private sensorTriggerEngine: SensorTriggerEngine | null = null;
  private sensorTriggerSessionId: string | null = null;
  private disposed = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.sessions = options.sessionStore ?? new InMemorySessionStore();
    this.traces = options.sessionTraceStore ?? new InMemorySessionTraceStore();
    this.queue = new DeviceCommandQueue(options.device);
    this.opossumQueue = options.opossum ? new OpossumCommandQueue(options.opossum) : undefined;
    this.toolRegistry =
      options.toolRegistry ??
      createDefaultToolRegistryWithDeps({ waveformLibrary: options.waveformLibrary });
    this.toolCallConfig = resolveToolCallConfig(options.toolCallConfig);

    const policyEngine = options.policyEngine ?? new PolicyEngine(createDefaultPolicyRules());
    const opossumPolicyEngine =
      options.opossumPolicyEngine ?? new OpossumPolicyEngine(createDefaultOpossumPolicyRules());
    const logger = options.logger ?? defaultLogger;
    this.toolExecutor = new RuntimeToolExecutor({
      device: options.device,
      opossum: options.opossum,
      pawPrints: options.pawPrints,
      civetEdging: options.civetEdging,
      permission: options.permission,
      queue: this.queue,
      opossumQueue: this.opossumQueue,
      toolRegistry: this.toolRegistry,
      policyEngine,
      opossumPolicyEngine,
      logger,
      toolCallConfig: this.toolCallConfig,
      emit: (event) => {
        this.events.emit(event);
      },
      enqueueTimerTrigger: (trigger) =>
        this.enqueueSystemWork(trigger.sessionId, { kind: 'timer-fired', trigger }),
      traceStore: this.traces,
    });

    this.disposeDeviceListener = options.device.onStateChanged((state) => {
      if (this.disposed) return;
      this.events.emit({ type: 'device-state-changed', state });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeDeviceListener();
    this.toolExecutor.cancelScheduledTimers();
    this.teardownSensorTriggerEngine();
    for (const controller of this.activeTurns.values()) {
      controller.abort();
    }
    this.activeTurns.clear();
    this.pendingSystemWork.clear();
  }

  /**
   * Opt-in gate for the Sensor Trigger Engine (see sensor-trigger-engine.ts).
   * Defaults to off — connecting a paw-prints/civet-edging sensor is never
   * enough on its own to start feeding ephemeral prompts into a session; the
   * user has to explicitly flip this on per session first, mirroring the
   * "explicit consent, default off" pattern used elsewhere in this app
   * (e.g. permissions-browser's timed grants).
   *
   * At most one engine is active at a time, scoped to a single session (the
   * device connections themselves are process-global, same as Coyote's
   * `device`, but "let sensor events interrupt the AI" is a per-conversation
   * decision). Enabling it for a different session tears down the previous
   * one first.
   */
  async setSensorTriggersEnabled(sessionId: string, enabled: boolean): Promise<void> {
    const session = await this.ensureSession(sessionId);
    session.metadata = withSensorTriggersEnabled(session.metadata, enabled);
    session.updatedAt = Date.now();
    await this.saveSessionIfAvailable(session);

    if (this.sensorTriggerSessionId && this.sensorTriggerSessionId !== sessionId) {
      this.teardownSensorTriggerEngine();
    }

    if (!enabled) {
      this.teardownSensorTriggerEngine();
      return;
    }

    if (this.sensorTriggerEngine) return;

    if (!this.options.pawPrints && !this.options.civetEdging) {
      // Nothing connected to subscribe to right now. The flag is persisted
      // above so a future connect step (out of this task's scope — see
      // report) can attach the engine once a sensor is actually available.
      return;
    }

    this.sensorTriggerEngine = new SensorTriggerEngine({
      sessionId,
      pawPrints: this.options.pawPrints,
      civetEdging: this.options.civetEdging,
      ...this.options.sensorTriggerOptions,
      onTrigger: (trigger) =>
        this.enqueueSystemWork(trigger.sessionId, { kind: 'sensor-fired', trigger }),
    });
    this.sensorTriggerSessionId = sessionId;
  }

  async isSensorTriggersEnabledForSession(sessionId: string): Promise<boolean> {
    const session = await this.sessions.get(sessionId);
    return isSensorTriggersEnabled(session?.metadata);
  }

  private teardownSensorTriggerEngine(): void {
    this.sensorTriggerEngine?.dispose();
    this.sensorTriggerEngine = null;
    this.sensorTriggerSessionId = null;
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

  /**
   * Restore previously exported sessions into the store. Existing sessions with
   * the same id are overwritten (import acts as backup/restore, not append).
   */
  async importSessions(sessions: SessionSnapshot[]): Promise<void> {
    for (const session of sessions) {
      this.deletedSessionIds.delete(session.id);
      await this.sessions.save(session);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessionIds.add(sessionId);
    await this.abortCurrentReply(sessionId);
    this.toolExecutor.cancelScheduledTimers(sessionId);
    this.pendingSystemWork.delete(sessionId);
    this.drainingSessions.delete(sessionId);
    if (this.sensorTriggerSessionId === sessionId) {
      this.teardownSensorTriggerEngine();
    }
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
    // Best-effort: the panic button should also silence Opossum vibration,
    // not just Coyote stim. Bypasses the opossum queue the same way Coyote's
    // emergencyStop bypasses `DeviceCommandQueue`'s normal serialization.
    await this.options.opossum?.emergencyStop();
  }

  async abortCurrentReply(sessionId: string): Promise<void> {
    this.activeTurns.get(sessionId)?.abort();
  }

  async sendUserMessage(input: SendUserMessageInput): Promise<void> {
    if (this.isSessionDeleted(input.sessionId)) {
      if (isInternallyTriggeredSourceType(input.context.sourceType)) {
        return;
      }
      this.deletedSessionIds.delete(input.sessionId);
    }

    if (this.activeTurns.has(input.sessionId)) {
      if (isInternallyTriggeredSourceType(input.context.sourceType)) {
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
          ...(await this.getAuxDeviceStatesForInstructions()),
        }) ?? '';
      const tools =
        input.context.sourceType === 'system'
          ? []
          : filterToolDefinitionsByConnectedDevices(
              await this.toolRegistry.listDefinitions(),
              await this.toolExecutor.getConnectedDeviceKinds(session),
            );
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
      const hasTextOrReasoning =
        iterationAssistantContent.trim().length > 0 ||
        (llmResult.reasoningContent?.trim().length ?? 0) > 0;
      const hasToolCalls = (llmResult.toolCalls?.length ?? 0) > 0;
      const iterationHasAssistantState = hasTextOrReasoning || hasToolCalls;

      if (iterationHasAssistantState) {
        if (hasTextOrReasoning) {
          appendAssistantMessage(
            session,
            {
              content: iterationAssistantContent,
              reasoningContent: llmResult.reasoningContent,
              toolCalls: llmResult.toolCalls,
            },
            turnStartIndex,
          );
        }
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
        const disconnectedDeviceKind = getDisconnectedDeviceKind(
          toolCall.name,
          toolCall.args,
          output,
        );
        if (disconnectedDeviceKind !== undefined) {
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
            finalAssistantText: buildDeviceDisconnectedMessage(disconnectedDeviceKind),
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
          ...(await this.getAuxDeviceStatesForInstructions()),
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

  /**
   * Mirrors `processTimerTrigger`: a `SensorFiredTrigger` from the Sensor
   * Trigger Engine becomes a trace entry plus one ephemeral, non-persisted
   * system turn — never a raw sensor reading forwarded verbatim, and never
   * written into `session.messages` (see docs/architecture.md's "ephemeral
   * trigger" concept).
   */
  private async processSensorTrigger(trigger: SensorFiredTrigger): Promise<void> {
    if (this.isSessionDeleted(trigger.sessionId)) {
      return;
    }
    // Defense in depth: even though `setSensorTriggersEnabled(false)` tears
    // down the engine (so this shouldn't normally fire once disabled), a
    // trigger emitted just before teardown could still be in flight in the
    // system-work queue. Re-check the persisted flag before acting on it.
    if (!(await this.isSensorTriggersEnabledForSession(trigger.sessionId))) {
      return;
    }
    const session = await this.ensureSession(trigger.sessionId);
    session.metadata = withSensorLastReading(session.metadata, trigger.deviceKind, {
      summary: trigger.summary,
      firedAt: trigger.firedAt,
    });
    session.updatedAt = Date.now();
    await this.saveSessionIfAvailable(session);
    await this.traces.append(trigger.sessionId, {
      kind: 'sensor-fired',
      turnId: `sensor-${trigger.firedAt}`,
      sourceType: 'sensor',
      synthetic: true,
      detail: trigger.summary,
      firedAt: trigger.firedAt,
    });

    // sourceType: 'sensor' (not 'system') deliberately — a sensor event is a
    // real, physical signal the user caused (unlike a timer firing), so it's
    // allowed to carry tools through runToolLoop's tool-list gate (which
    // only empties tools for 'system'). All the usual safety layers still
    // apply in full: filterToolDefinitionsByConnectedDevices, permission
    // gate, policy clamps, per-turn caps — this only lifts the blanket
    // "system turns never touch the device" rule for this one case.
    await this.sendUserMessage({
      sessionId: trigger.sessionId,
      text: buildSensorTriggerPrompt(trigger),
      context: {
        sessionId: trigger.sessionId,
        sourceType: 'sensor',
        traceId: `sensor-${trigger.firedAt}`,
      },
      persistMessage: false,
    });
  }

  /**
   * Fetches current Opossum/sensor state for `buildInstructions`, omitting a
   * key entirely when that device kind was never configured for this runtime
   * (as opposed to configured-but-disconnected, which still reports state —
   * `buildInstructions` uses presence-vs-absence to decide whether to
   * mention a device kind at all).
   */
  private async getAuxDeviceStatesForInstructions(): Promise<{
    opossumState?: OpossumState;
    pawPrintsState?: SensorState;
    civetEdgingState?: SensorState;
  }> {
    const [opossumState, pawPrintsState, civetEdgingState] = await Promise.all([
      this.options.opossum?.getState(),
      this.options.pawPrints?.getState(),
      this.options.civetEdging?.getState(),
    ]);
    return { opossumState, pawPrintsState, civetEdgingState };
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

        if (next.kind === 'sensor-fired') {
          await this.processSensorTrigger(next.trigger);
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
    }
  | {
      kind: 'sensor-fired';
      trigger: SensorFiredTrigger;
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

/**
 * Mirrors `buildTimerTriggerPrompt`'s tone/structure: state what happened,
 * make explicit this isn't a real user message, then a guardrail line — but
 * unlike a timer firing, this turn's tools are NOT emptied (sourceType:
 * 'sensor', not 'system' — see runToolLoop), so the guardrail here has to
 * spell out how to use that access responsibly rather than just forbidding
 * it: a sensor trigger is a plausible signal the user actually wants a
 * reaction to, just not an automatic or repeated one. All the usual policy
 * clamps/permission gate/per-turn caps still apply in full to any tool call
 * made here — this prompt is guidance, not the safety boundary itself.
 */
function buildSensorTriggerPrompt(trigger: SensorFiredTrigger): string {
  return [
    `[内部提醒] 传感器事件：${trigger.summary}。`,
    '这不是用户的新消息，用户没有提供新的反馈。',
    '你可以按当前剧情自行判断是否需要用工具做出响应，但最多只推进一小步就停下观察，不要连续加码或反复触发；同样不得超过任何强度/次数上限。',
    '如果只是想确认状态或不确定该不该动，直接不调用工具、简短观察即可。',
  ].join('\n');
}

/** Timer/sensor triggers are internal signals, not a direct user action —
 * they must never resurrect a deleted session or bypass the single-active-turn
 * invariant by throwing (queue instead, mirroring the existing 'system' case). */
function isInternallyTriggeredSourceType(sourceType: SourceType): boolean {
  return sourceType === 'system' || sourceType === 'sensor';
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

/**
 * Tri-state on purpose: `undefined` means "this output isn't a disconnected-
 * device denial at all, keep going normally"; `null`/a `DeviceKind` both
 * mean "stop the turn", differing only in whether we know which device kind
 * to name in the guidance message (set_indicator_color with a malformed
 * `deviceKind` arg can't be resolved, so it falls back to a generic name).
 */
function getDisconnectedDeviceKind(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): DeviceKind | null | undefined {
  if (!isDeviceToolName(toolName)) return undefined;

  try {
    const parsed = JSON.parse(output) as { error?: string };
    if (parsed.error !== '设备未连接') return undefined;
  } catch {
    return undefined;
  }

  return resolveRequiredDeviceKind(toolName, args);
}

function buildDeviceDisconnectedMessage(kind: DeviceKind | null): string {
  const name = kind ? DEVICE_KIND_DISPLAY_NAME[kind] : '设备';
  return `设备未连接，请先点击输入框旁的蓝牙图标连接${name}。`;
}
