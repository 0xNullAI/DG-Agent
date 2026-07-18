import type { DeviceClient, Logger, PermissionService, SessionTraceStore } from '@dg-agent/core';
import {
  isDeviceToolName,
  type ActionContext,
  type DeviceCommand,
  type DeviceKind,
  type OpossumCommand,
  type RuntimeEvent,
  type SessionSnapshot,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutionPlan,
} from '@dg-agent/core';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from './device-clients.js';
import type { DeviceCommandQueue, OpossumCommandQueue } from './device-command-queue.js';
import { throwIfAborted } from './runtime-errors.js';
import { consumeTurnQuota, type TurnState } from './runtime-turn-state.js';
import type { OpossumPolicyEngine, PolicyEngine } from './policy-engine.js';
import type { ToolCallConfig } from './tool-call-config.js';
import type { ToolRegistry } from './tool-registry.js';

export { DEVICE_KIND_DISPLAY_NAME } from './device-clients.js';

/**
 * Which device kind a given LLM tool call targets. Coyote tools map
 * statically; `set_indicator_color` is polymorphic (its `deviceKind` arg
 * picks the target), and everything else (timer, design_wave) needs no
 * device at all. Exported so `agent-runtime.ts` can build the same
 * "please connect X" guidance message when a turn stops on a disconnected
 * device.
 */
export function resolveRequiredDeviceKind(
  toolName: string,
  args: Record<string, unknown> | undefined,
): DeviceKind | null {
  switch (toolName) {
    case 'start':
    case 'stop':
    case 'adjust_strength':
    case 'change_wave':
    case 'burst':
      return 'coyote';
    case 'vibrate_start':
    case 'vibrate_stop':
    case 'vibrate_adjust':
      return 'opossum';
    case 'set_indicator_color': {
      const kind = args?.deviceKind;
      return kind === 'paw-prints' || kind === 'civet-edging' || kind === 'opossum' ? kind : null;
    }
    default:
      return null;
  }
}

const LED_CAPABLE_DEVICE_KINDS = ['paw-prints', 'civet-edging', 'opossum'] as const;

/**
 * Filters (and, for `set_indicator_color`, narrows) the tool definitions
 * sent to the LLM so it only ever sees tools for device kinds that are
 * actually connected right now. Device-tool calls were already denied at
 * execution time when the target wasn't connected (`isDeviceKindConnected`
 * below) — but that meant the LLM could still see and attempt e.g.
 * `vibrate_start` with no Opossum connected, burning a turn on a call that
 * was always going to fail. Tools that need no device (`timer`,
 * `design_wave`) are unaffected.
 */
export function filterToolDefinitionsByConnectedDevices(
  definitions: ToolDefinition[],
  connectedKinds: ReadonlySet<DeviceKind>,
): ToolDefinition[] {
  const result: ToolDefinition[] = [];
  for (const definition of definitions) {
    if (definition.name === 'set_indicator_color') {
      const allowedKinds = LED_CAPABLE_DEVICE_KINDS.filter((kind) => connectedKinds.has(kind));
      if (allowedKinds.length === 0) continue;
      result.push(narrowIndicatorColorDeviceKindEnum(definition, allowedKinds));
      continue;
    }

    const requiredKind = resolveRequiredDeviceKind(definition.name, undefined);
    if (requiredKind && !connectedKinds.has(requiredKind)) continue;
    result.push(definition);
  }
  return result;
}

/**
 * `set_indicator_color` targets whichever device kind its `deviceKind`
 * argument names, so it can't be dropped outright the way a
 * single-device-kind tool can — instead narrow the parameter's enum to only
 * the kinds actually connected, so the LLM can't pick a disconnected target
 * and get an immediate denial.
 */
function narrowIndicatorColorDeviceKindEnum(
  definition: ToolDefinition,
  allowedKinds: readonly DeviceKind[],
): ToolDefinition {
  const parameters = definition.parameters as {
    properties?: Record<string, unknown>;
  };
  const deviceKindProperty = parameters.properties?.deviceKind as
    | Record<string, unknown>
    | undefined;
  if (!deviceKindProperty) return definition;

  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...parameters.properties,
        deviceKind: { ...deviceKindProperty, enum: allowedKinds },
      },
    },
  };
}

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
  opossum?: OpossumClient;
  pawPrints?: PawPrintsClient;
  civetEdging?: CivetEdgingClient;
  permission: PermissionService;
  queue: DeviceCommandQueue;
  opossumQueue?: OpossumCommandQueue;
  toolRegistry: ToolRegistry;
  policyEngine: PolicyEngine;
  opossumPolicyEngine: OpossumPolicyEngine;
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
      const requiredKind = resolveRequiredDeviceKind(toolCall.name, toolCall.args);
      if (!requiredKind) {
        return this.denyToolCall(session, displayToolCall, '无法确定目标设备种类', context);
      }
      const connected = await this.isDeviceKindConnected(requiredKind, session);
      if (!connected) {
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

    if (planResult.plan.type === 'opossum') {
      return this.executeOpossumCommand({
        session,
        toolCall: displayToolCall,
        context,
        command: planResult.plan.command,
        abortSignal,
      });
    }

    if (planResult.plan.type === 'setIndicatorColor') {
      return this.executeSetIndicatorColor({
        session,
        toolCall: displayToolCall,
        context,
        deviceKind: planResult.plan.deviceKind,
        color: planResult.plan.color,
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

  /**
   * Checks connection state for whichever device kind a tool call actually
   * targets, instead of assuming "the device" always means Coyote. Also
   * preserves the old side effect of refreshing `session.deviceState` from
   * the live Coyote state, scoped now to only the coyote branch (the other
   * device kinds don't have a slot in `SessionSnapshot.deviceState`, which
   * stays Coyote-shaped by design).
   */
  /**
   * Which device kinds are connected right now. Public so `agent-runtime.ts`
   * can filter the tool list sent to the LLM before each turn, not just deny
   * a call after the fact — see `filterToolDefinitionsByConnectedDevices`.
   */
  async getConnectedDeviceKinds(session: SessionSnapshot): Promise<Set<DeviceKind>> {
    const connected = new Set<DeviceKind>();

    const coyoteState = await this.options.device.getState();
    session.deviceState = coyoteState;
    if (coyoteState.connected) connected.add('coyote');

    if (this.options.opossum && (await this.options.opossum.getState()).connected) {
      connected.add('opossum');
    }
    if (this.options.pawPrints && (await this.options.pawPrints.getState()).connected) {
      connected.add('paw-prints');
    }
    if (this.options.civetEdging && (await this.options.civetEdging.getState()).connected) {
      connected.add('civet-edging');
    }

    return connected;
  }

  private async isDeviceKindConnected(
    kind: DeviceKind,
    session: SessionSnapshot,
  ): Promise<boolean> {
    return (await this.getConnectedDeviceKinds(session)).has(kind);
  }

  private getIndicatorCapableClient(
    deviceKind: DeviceKind,
  ): { setIndicatorColor(color: number): Promise<void> } | null {
    switch (deviceKind) {
      case 'paw-prints': {
        const client = this.options.pawPrints;
        return client?.setIndicatorColor
          ? { setIndicatorColor: (c) => client.setIndicatorColor!(c) }
          : null;
      }
      case 'civet-edging': {
        const client = this.options.civetEdging;
        return client?.setIndicatorColor
          ? { setIndicatorColor: (c) => client.setIndicatorColor!(c) }
          : null;
      }
      case 'opossum':
        return this.options.opossum ?? null;
      default:
        return null;
    }
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

  private async executeOpossumCommand(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    command: OpossumCommand;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const { session, toolCall, context, abortSignal } = input;
    let { command } = input;

    if (!this.options.opossum || !this.options.opossumQueue) {
      return this.denyToolCall(session, toolCall, '设备未连接', context);
    }
    const opossum = this.options.opossum;
    const opossumQueue = this.options.opossumQueue;

    throwIfAborted(abortSignal);
    const currentState = await opossum.getState();

    // Same clamp-then-deny/confirm loop as executeDeviceCommand, run against
    // the Opossum-specific policy engine instead. See that method's comment
    // for why this re-evaluates in a loop rather than stopping at the first
    // clamp.
    const initialCommand = command;
    const clampReasons: string[] = [];
    let needsConfirm = false;
    let confirmReason = '';
    let denyReason: string | undefined;
    let exhausted = true;

    for (let iter = 0; iter < POLICY_RESOLVE_MAX_ITERATIONS; iter += 1) {
      const decision = this.options.opossumPolicyEngine.evaluate({
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
      clampReasons.push(decision.reason);
      command = decision.command;
    }

    const clampedFrom =
      clampReasons.length > 0
        ? { command: initialCommand, reason: clampReasons.join('; ') }
        : undefined;

    if (clampedFrom) {
      this.options.logger.warn('Opossum command clamped by policy.', {
        sessionId: session.id,
        toolName: toolCall.name,
        reason: clampedFrom.reason,
      });
    }

    if (exhausted) {
      this.options.logger.error('Opossum policy clamp loop did not converge.', {
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
        summary: toolCall.displayName ?? toolCall.name,
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
    });

    try {
      const result = await opossumQueue.enqueue(command);

      const output = JSON.stringify({
        ok: clampedFrom ? 'clamped' : true,
        command,
        state: result.state,
        ...(clampedFrom
          ? {
              clampedFrom: clampedFrom.command,
              _warning: `策略限制：原始命令被调整为上面的 command。回复用户时请按实际执行值（command 字段）说明，不要按原始请求复述。原因：${clampedFrom.reason}`,
            }
          : {}),
        _hint: '以上 state 是负鼠设备当前真实状态，请根据此状态回复用户。',
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

  private async executeSetIndicatorColor(input: {
    session: SessionSnapshot;
    toolCall: ToolCall;
    context: ActionContext;
    deviceKind: DeviceKind;
    color: number;
  }): Promise<string> {
    const { session, toolCall, context, deviceKind, color } = input;
    const client = this.getIndicatorCapableClient(deviceKind);
    if (!client) {
      return this.denyToolCall(session, toolCall, '设备未连接', context);
    }

    this.options.emit({
      type: 'tool-call-executing',
      sessionId: session.id,
      toolCall,
    });

    try {
      await client.setIndicatorColor(color);
      const output = JSON.stringify({
        ok: true,
        deviceKind,
        color,
        _hint: '指示灯颜色已更新，纯外观变化，不影响强度/振动输出。',
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
