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
}

export class RuntimeToolExecutor {
  private readonly scheduledTimers = new Map<string, ScheduledTimer>();

  constructor(private readonly options: RuntimeToolExecutorOptions) {}

  async execute(input: ExecuteToolCallInput): Promise<string> {
    const { session, toolCall, context, turnState, abortSignal } = input;
    const toolDisplayName = this.options.toolRegistry.getDisplayName(toolCall.name);
    const displayToolCall = toolDisplayName
      ? { ...toolCall, displayName: toolDisplayName }
      : toolCall;

    throwIfAborted(abortSignal);
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
      return this.scheduleTimer(session, planResult.plan.command, context);
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

  private async recordInlineResult(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    plan: Extract<ToolExecutionPlan, { type: 'inline' }>;
  }): Promise<string> {
    const { session, toolCall, context, plan } = input;
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
  ): Promise<string> {
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

    let decision = this.options.policyEngine.evaluate({
      context,
      command,
      deviceState: currentState,
    });

    if (decision.type === 'require-confirm') {
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
        return this.denyToolCall(session, toolCall, permission.reason ?? decision.reason, context);
      }

      decision = { type: 'allow' };
    }

    if (decision.type === 'deny') {
      return this.denyToolCall(session, toolCall, decision.reason, context);
    }

    let clampReason: string | undefined;
    if (decision.type === 'clamp') {
      this.options.logger.warn('Command clamped by policy.', {
        sessionId: session.id,
        toolName: toolCall.name,
        reason: decision.reason,
      });
      clampReason = decision.reason;
      command = decision.command;
    }

    throwIfAborted(abortSignal);

    try {
      const result = await this.options.queue.enqueue(command);
      session.deviceState = result.state;

      this.options.emit({
        type: 'device-command-executed',
        sessionId: session.id,
        command,
        result,
      });

      const output = JSON.stringify({
        ok: true,
        command,
        state: result.state,
        notes: result.notes ?? [],
        ...(clampReason ? { _clamped: clampReason } : {}),
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
