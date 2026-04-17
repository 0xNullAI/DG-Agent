import type { DevicePort, LoggerPort, PermissionPort } from '@dg-agent/contracts';
import type { ActionContext, DeviceCommand, RuntimeEvent, SessionSnapshot, ToolCall, ToolExecutionPlan } from '@dg-agent/core';
import { summarizeCommand } from './default-policies.js';
import { DeviceCommandQueue } from './device-command-queue.js';
import { throwIfAborted } from './runtime-errors.js';
import { consumeTurnQuota, type TurnState } from './runtime-turn-state.js';
import type { PolicyEngine } from './policy-engine.js';
import type { ToolCallConfig } from './tool-call-config.js';
import type { ToolRegistry } from './tool-registry.js';

interface ScheduledTimer {
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface RuntimeFollowUpInput {
  sessionId: string;
  text: string;
  context: ActionContext;
}

export interface RuntimeToolExecutorOptions {
  device: DevicePort;
  permission: PermissionPort;
  queue: DeviceCommandQueue;
  toolRegistry: ToolRegistry;
  policyEngine: PolicyEngine;
  logger: LoggerPort;
  toolCallConfig: ToolCallConfig;
  emit: (event: RuntimeEvent) => void;
  sendUserMessage: (input: RuntimeFollowUpInput) => Promise<void>;
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

    throwIfAborted(abortSignal);
    this.options.emit({
      type: 'tool-call-proposed',
      sessionId: session.id,
      toolCall,
    });

    const quotaError = consumeTurnQuota(toolCall.name, turnState, this.options.toolCallConfig);
    if (quotaError) {
      return this.denyToolCall(session.id, toolCall, quotaError);
    }

    const planResult = await this.resolvePlan(session.id, toolCall);
    if ('error' in planResult) {
      return JSON.stringify({ error: planResult.error });
    }

    throwIfAborted(abortSignal);

    if (planResult.plan.type === 'timer') {
      return this.scheduleTimer(session, planResult.plan.command);
    }

    return this.executeDeviceCommand({
      session,
      toolCall,
      context,
      command: planResult.plan.command,
      abortSignal,
    });
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

  private scheduleTimer(
    session: SessionSnapshot,
    command: Extract<ToolExecutionPlan, { type: 'timer' }>['command'],
  ): string {
    const dueAt = Date.now() + command.seconds * 1000;
    const timerId = `${session.id}:${command.label}:${dueAt}`;
    const timer = setTimeout(() => {
      this.scheduledTimers.delete(timerId);
      this.options.emit({
        type: 'timer-fired',
        sessionId: session.id,
        label: command.label,
        firedAt: Date.now(),
      });
      void this.options.sendUserMessage({
        sessionId: session.id,
        text: `[Timer due]\nlabel: ${command.label}\nseconds: ${command.seconds}`,
        context: {
          sessionId: session.id,
          sourceType: 'system',
          traceId: `timer-${Date.now()}`,
        },
      });
    }, command.seconds * 1000);

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
      return this.denyToolCall(session.id, toolCall, burstError);
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
        summary: summarizeCommand(command),
        args: toolCall.args,
      });

      throwIfAborted(abortSignal);

      if (permission.type === 'deny') {
        return this.denyToolCall(session.id, toolCall, permission.reason ?? decision.reason);
      }

      decision = { type: 'allow' };
    }

    if (decision.type === 'deny') {
      return this.denyToolCall(session.id, toolCall, decision.reason);
    }

    if (decision.type === 'clamp') {
      this.options.logger.warn('Command clamped by policy.', {
        sessionId: session.id,
        toolName: toolCall.name,
        reason: decision.reason,
      });
      command = decision.command;
    }

    throwIfAborted(abortSignal);

    const result = await this.options.queue.enqueue(command);
    session.deviceState = result.state;

    this.options.emit({
      type: 'device-command-executed',
      sessionId: session.id,
      command,
      result,
    });

    return JSON.stringify({
      ok: true,
      command,
      state: result.state,
      notes: result.notes ?? [],
    });
  }

  private denyToolCall(sessionId: string, toolCall: ToolCall, reason: string): string {
    this.options.emit({
      type: 'tool-call-denied',
      sessionId,
      toolCall,
      reason,
    });
    return JSON.stringify({ error: reason });
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

  return `Channel ${command.channel} is not currently running (strength=${current}, waveActive=${waveActive}); burst requires an already active channel. Start the channel first, then call burst.`;
}
