import type { DeviceClient, Logger, PermissionService, SessionTraceStore } from '@dg-agent/core';
import {
  isDeviceToolName,
  type ActionContext,
  type DeviceCommand,
  type RuntimeEvent,
  type SessionSnapshot,
  type ToolCall,
  type ToolExecutionPlan,
} from '@dg-agent/core';
import type { DeviceCommandQueue } from './device-command-queue.js';
import { throwIfAborted } from './runtime-errors.js';
import { consumeTurnQuota, type TurnState } from './runtime-turn-state.js';
import type { PolicyEngine } from './policy-engine.js';
import type { ToolCallConfig } from './tool-call-config.js';
import type { ToolRegistry } from './tool-registry.js';
import { RUNTIME_CONTEXT_TOOL_NAME } from './runtime-context-tool.js';

// Clamp rules are convergent in practice (each pass narrows the command),
// but bound the loop in case a custom rule keeps clamping. 4 is enough for
// the worst real chain — burst-strength-cap → user-strength-cap → step-adjust
// → permission-gate — with one slot of safety margin.
const POLICY_RESOLVE_MAX_ITERATIONS = 4;

interface ScheduledTimer {
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface TimerFiredTrigger {
  sessionId: string;
  label: string;
  seconds: number;
  firedAt: number;
}

export interface RuntimeToolExecutorOptions {
  device: DeviceClient;
  permission: PermissionService;
  queue: DeviceCommandQueue;
  toolRegistry: ToolRegistry;
  policyEngine: PolicyEngine;
  logger: Logger;
  toolCallConfig: ToolCallConfig;
  buildRuntimeContext?: (input: {
    session: SessionSnapshot;
    context: ActionContext;
    turnState: TurnState;
    isFirstIteration: boolean;
  }) => string;
  emit: (event: RuntimeEvent) => void;
  enqueueTimerTrigger: (trigger: TimerFiredTrigger) => void;
  traceStore: SessionTraceStore;
}

export interface ExecuteToolCallInput {
  session: SessionSnapshot;
  toolCall: ToolCall;
  context: ActionContext;
  turnState: TurnState;
  abortSignal?: AbortSignal;
  llmIteration?: number;
}

export class RuntimeToolExecutor {
  private readonly scheduledTimers = new Map<string, ScheduledTimer>();

  constructor(private readonly options: RuntimeToolExecutorOptions) {}

  async execute(input: ExecuteToolCallInput): Promise<string> {
    const { session, toolCall, context, turnState, abortSignal, llmIteration = 0 } = input;
    const toolDisplayName = this.options.toolRegistry.getDisplayName(toolCall.name);
    const displayToolCall = toolDisplayName
      ? { ...toolCall, displayName: toolDisplayName }
      : toolCall;

    throwIfAborted(abortSignal);

    if (toolCall.name === RUNTIME_CONTEXT_TOOL_NAME) {
      return this.executeRuntimeContext({
        session,
        toolCall: displayToolCall,
        context,
        turnState,
        isFirstIteration: llmIteration === 0,
      });
    }

    this.options.emit({
      type: 'tool-call-proposed',
      sessionId: session.id,
      toolCall: displayToolCall,
    });
    await this.options.traceStore.append(session.id, {
      kind: 'tool-call',
      turnId: context.traceId,
      sourceType: context.sourceType,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolDisplayName,
      args: toolCall.args,
    });

    const quotaError = consumeTurnQuota(
      toolCall.name,
      turnState,
      this.options.toolCallConfig,
      toolCall.args,
    );
    if (quotaError) {
      return this.denyToolCall(session, displayToolCall, quotaError, context);
    }

    if (isDeviceToolName(toolCall.name)) {
      const currentState = await this.options.device.getState();
      session.deviceState = currentState;
      if (!currentState.connected) {
        return this.denyToolCall(session, displayToolCall, '设备未连接', context);
      }
    }

    const planResult = await this.resolvePlan(session.id, displayToolCall);
    if ('error' in planResult) {
      await this.options.traceStore.append(session.id, {
        kind: 'tool-denied',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName,
        args: toolCall.args,
        detail: planResult.error,
      });
      return JSON.stringify({
        error: planResult.error,
        _meta: {
          kind: 'tool-denied',
          toolName: toolCall.name,
        },
      });
    }

    throwIfAborted(abortSignal);

    if (planResult.plan.type === 'timer') {
      return this.scheduleTimer(session, planResult.plan.command, context, displayToolCall);
    }

    if (planResult.plan.type === 'inline') {
      return this.recordInlineResult({
        session,
        toolCall: displayToolCall,
        context,
        plan: planResult.plan,
      });
    }

    return this.executeDeviceCommand({
      session,
      toolCall: displayToolCall,
      context,
      command: planResult.plan.command,
      abortSignal,
    });
  }

  private async executeRuntimeContext(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    turnState: TurnState;
    isFirstIteration: boolean;
  }): Promise<string> {
    const { session, toolCall, context, turnState, isFirstIteration } = input;
    const buildRuntimeContext = this.options.buildRuntimeContext;
    if (!buildRuntimeContext) {
      return JSON.stringify({
        error: 'runtime context provider is not configured',
        _meta: { kind: 'tool-failed', toolName: toolCall.name },
      });
    }

    session.deviceState = await this.options.device.getState();
    const output = buildRuntimeContext({
      session,
      context,
      turnState,
      isFirstIteration,
    });

    await this.options.traceStore.append(session.id, {
      kind: 'tool-result',
      turnId: context.traceId,
      sourceType: context.sourceType,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolDisplayName: toolCall.displayName,
      args: toolCall.args,
      output,
    });
    return output;
  }

  private async recordInlineResult(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    plan: Extract<ToolExecutionPlan, { type: 'inline' }>;
  }): Promise<string> {
    const { session, toolCall, context, plan } = input;
    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
    });
    await this.options.traceStore.append(session.id, {
      kind: 'tool-result',
      turnId: context.traceId,
      sourceType: context.sourceType,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolDisplayName: toolCall.displayName,
      args: toolCall.args,
      output: plan.output,
    });
    return plan.output;
  }

  cancelScheduledTimers(sessionId?: string): void {
    for (const [timerId, scheduled] of this.scheduledTimers.entries()) {
      if (sessionId && scheduled.sessionId !== sessionId) continue;
      clearTimeout(scheduled.timer);
      this.scheduledTimers.delete(timerId);
    }
  }

  private async resolvePlan(
    sessionId: string,
    toolCall: ToolCall,
  ): Promise<{ plan: ToolExecutionPlan } | { error: string }> {
    try {
      return {
        plan: await this.options.toolRegistry.resolve(toolCall),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.emit({
        type: 'tool-call-denied',
        sessionId,
        toolCall,
        reason,
      });
      return { error: reason };
    }
  }

  private async scheduleTimer(
    session: SessionSnapshot,
    command: Extract<ToolExecutionPlan, { type: 'timer' }>['command'],
    context: ActionContext,
    toolCall: ToolCall,
  ): Promise<string> {
    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
    });
    const dueAt = Date.now() + command.seconds * 1000;
    const timerId = `${session.id}:${command.label}:${dueAt}`;
    const timer = setTimeout(() => {
      const firedAt = Date.now();
      this.scheduledTimers.delete(timerId);
      this.options.emit({
        type: 'timer-fired',
        sessionId: session.id,
        label: command.label,
        firedAt,
      });
      this.options.enqueueTimerTrigger({
        sessionId: session.id,
        label: command.label,
        seconds: command.seconds,
        firedAt,
      });
    }, command.seconds * 1000);
    await this.options.traceStore.append(session.id, {
      kind: 'timer-scheduled',
      turnId: context.traceId,
      sourceType: context.sourceType,
      label: command.label,
      seconds: command.seconds,
      dueAt,
    });

    this.scheduledTimers.set(timerId, {
      sessionId: session.id,
      timer,
    });
    this.options.emit({
      type: 'timer-scheduled',
      sessionId: session.id,
      label: command.label,
      dueAt,
    });

    return JSON.stringify({
      timer: {
        id: timerId,
        label: command.label,
        seconds: command.seconds,
        dueAt,
      },
    });
  }

  private async executeDeviceCommand(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    command: DeviceCommand;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const { session, toolCall, context, abortSignal } = input;
    let { command } = input;

    throwIfAborted(abortSignal);

    const currentState = await this.options.device.getState();
    const burstError = validateBurstExecution(command, currentState, this.options.toolCallConfig);
    if (burstError) {
      return this.denyToolCall(session, toolCall, burstError, context);
    }

    // Resolve the policy decision in a loop so that a clamp doesn't
    // short-circuit later rules (especially permission-gate). The old code
    // returned at the first non-null rule — that meant any clamp would skip
    // the user's "每次询问" confirmation prompt (issue #65) and would also
    // mask any tighter cap from a later rule (e.g. channel strength cap
    // after a burst-specific cap). Now we re-evaluate the clamped command
    // until no more clamps fire, then handle deny / require-confirm.
    const initialCommand = command;
    const clampReasons: string[] = [];
    let needsConfirm = false;
    let confirmReason = '';
    let denyReason: string | undefined;
    let exhausted = true;

    for (let iter = 0; iter < POLICY_RESOLVE_MAX_ITERATIONS; iter += 1) {
      const decision = this.options.policyEngine.evaluate({
        context,
        command,
        deviceState: currentState,
      });

      if (decision.type === 'allow') {
        exhausted = false;
        break;
      }
      if (decision.type === 'deny') {
        denyReason = decision.reason;
        exhausted = false;
        break;
      }
      if (decision.type === 'require-confirm') {
        needsConfirm = true;
        confirmReason = decision.reason;
        exhausted = false;
        break;
      }
      // clamp
      clampReasons.push(decision.reason);
      command = decision.command;
    }

    const clampedFrom =
      clampReasons.length > 0
        ? { command: initialCommand, reason: clampReasons.join('; ') }
        : undefined;

    if (clampedFrom) {
      this.options.logger.warn('Command clamped by policy.', {
        sessionId: session.id,
        toolName: toolCall.name,
        reason: clampedFrom.reason,
      });
      this.options.emit({
        type: 'tool-call-clamped',
        sessionId: session.id,
        toolCall,
        originalCommand: initialCommand,
        adjustedCommand: command,
        reason: clampedFrom.reason,
      });
    }

    if (exhausted) {
      this.options.logger.error('Policy clamp loop did not converge.', {
        sessionId: session.id,
        toolName: toolCall.name,
        clampReasons,
      });
      return this.denyToolCall(
        session,
        toolCall,
        '策略评估未收敛（clamp 规则未稳定），本次调用被拒绝。',
        context,
      );
    }

    if (denyReason !== undefined) {
      return this.denyToolCall(session, toolCall, denyReason, context);
    }

    if (needsConfirm) {
      const permission = await this.options.permission.request({
        context,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        summary:
          this.options.toolRegistry.summarizeCommand(toolCall.name, command) ??
          toolCall.displayName ??
          toolCall.name,
        args: toolCall.args,
      });

      throwIfAborted(abortSignal);

      if (permission.type === 'deny') {
        return this.denyToolCall(session, toolCall, permission.reason ?? confirmReason, context);
      }
    }

    throwIfAborted(abortSignal);

    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
      command,
      ...(clampedFrom ? { clampedFrom } : {}),
    });

    try {
      const result = await this.options.queue.enqueue(command);
      session.deviceState = result.state;

      this.options.emit({
        type: 'device-command-executed',
        sessionId: session.id,
        command,
        result,
      });

      const baseNotes = result.notes ?? [];
      const notes = clampedFrom
        ? [...baseNotes, `policy-clamped: ${clampedFrom.reason}`]
        : baseNotes;

      const output = JSON.stringify({
        ok: clampedFrom ? 'clamped' : true,
        command,
        state: result.state,
        notes,
        ...(clampedFrom
          ? {
              clampedFrom: clampedFrom.command,
              _warning: `策略限制：原始命令被调整为上面的 command。回复用户时请按实际执行值（command 字段）说明，不要按原始请求复述。原因：${clampedFrom.reason}`,
            }
          : {}),
        _hint: '以上 state 是设备当前真实状态，请根据此状态回复用户。',
      });
      await this.options.traceStore.append(session.id, {
        kind: 'tool-result',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        args: toolCall.args,
        output,
      });
      return output;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.emit({
        type: 'tool-call-failed',
        sessionId: session.id,
        toolCall,
        error: reason,
      });
      await this.options.traceStore.append(session.id, {
        kind: 'tool-failed',
        turnId: context.traceId,
        sourceType: context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolDisplayName: toolCall.displayName,
        args: toolCall.args,
        detail: reason,
      });
      return JSON.stringify({
        error: reason,
        _meta: {
          kind: 'tool-failed',
          toolName: toolCall.name,
        },
      });
    }
  }

  private async denyToolCall(
    session: SessionSnapshot,
    toolCall: ToolCall,
    reason: string,
    context: ActionContext,
  ): Promise<string> {
    this.options.emit({
      type: 'tool-call-denied',
      sessionId: session.id,
      toolCall,
      reason,
    });
    await this.options.traceStore.append(session.id, {
      kind: 'tool-denied',
      turnId: context.traceId,
      sourceType: context.sourceType,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolDisplayName: toolCall.displayName,
      args: toolCall.args,
      detail: reason,
    });
    return JSON.stringify({
      error: reason,
      _meta: {
        kind: 'tool-denied',
        toolName: toolCall.name,
      },
    });
  }
}

function validateBurstExecution(
  command: DeviceCommand,
  deviceState: SessionSnapshot['deviceState'],
  config: ToolCallConfig,
): string | null {
  if (command.type !== 'burst' || !config.burstRequiresActiveChannel) return null;

  const current = command.channel === 'A' ? deviceState.strengthA : deviceState.strengthB;
  const waveActive = command.channel === 'A' ? deviceState.waveActiveA : deviceState.waveActiveB;
  if (current > 0 && waveActive) return null;

  return `当前通道 ${command.channel} 还没有运行（strength=${current}, waveActive=${waveActive}），不能直接执行 burst，请先启动通道`;
}
