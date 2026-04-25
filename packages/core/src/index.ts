export type Channel = 'A' | 'B';
export type SourceType = 'web' | 'qq' | 'telegram' | 'cli' | 'api' | 'system';
export type MessageRole = 'system' | 'user' | 'assistant';
export type ModelContextStrategy = 'last-user-turn' | 'last-five-user-turns' | 'full-history';
export type WaveFrame = [number, number];

export interface WaveformDefinition {
  id: string;
  name: string;
  description?: string;
  frames: WaveFrame[];
}

export interface DeviceState {
  connected: boolean;
  deviceName?: string;
  address?: string;
  battery?: number;
  strengthA: number;
  strengthB: number;
  limitA: number;
  limitB: number;
  waveActiveA: boolean;
  waveActiveB: boolean;
  currentWaveA?: string;
  currentWaveB?: string;
}

export interface ActionContext {
  sessionId: string;
  sourceType: SourceType;
  sourceUserId?: string;
  sourceUserName?: string;
  sourceChannelId?: string;
  traceId: string;
}

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  displayName?: string;
  args: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  displayName?: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SessionSnapshot {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
  deviceState: DeviceState;
  metadata?: Record<string, unknown>;
}

export interface BridgeOriginMetadata {
  platform: 'qq' | 'telegram';
  userId: string;
  userName?: string;
}

export const BRIDGE_ORIGIN_METADATA_KEY = 'bridgeOrigin';

export function getBridgeOriginMetadata(
  metadata: Record<string, unknown> | undefined,
): BridgeOriginMetadata | null {
  const value = metadata?.[BRIDGE_ORIGIN_METADATA_KEY];
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const platform = record.platform;
  const userId = record.userId;
  const userName = record.userName;

  if (
    (platform !== 'qq' && platform !== 'telegram') ||
    typeof userId !== 'string' ||
    userId.trim() === ''
  ) {
    return null;
  }

  return {
    platform,
    userId,
    userName: typeof userName === 'string' && userName.trim() ? userName : undefined,
  };
}

export function mergeBridgeOriginMetadata(
  metadata: Record<string, unknown> | undefined,
  context: Pick<ActionContext, 'sourceType' | 'sourceUserId' | 'sourceUserName'>,
): Record<string, unknown> | undefined {
  if (
    (context.sourceType !== 'qq' && context.sourceType !== 'telegram') ||
    !context.sourceUserId?.trim()
  ) {
    return metadata;
  }

  return {
    ...(metadata ?? {}),
    [BRIDGE_ORIGIN_METADATA_KEY]: {
      platform: context.sourceType,
      userId: context.sourceUserId,
      userName: context.sourceUserName?.trim() || undefined,
    } satisfies BridgeOriginMetadata,
  };
}

export type RuntimeTraceEntryKind =
  | 'tool-call'
  | 'tool-result'
  | 'tool-denied'
  | 'tool-failed'
  | 'timer-scheduled'
  | 'timer-fired';

export interface RuntimeTraceEntry {
  id: string;
  createdAt: number;
  kind: RuntimeTraceEntryKind;
  turnId?: string;
  sourceType?: SourceType;
  synthetic?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolDisplayName?: string;
  args?: Record<string, unknown>;
  output?: string;
  detail?: string;
  label?: string;
  seconds?: number;
  dueAt?: number;
  firedAt?: number;
}

export type DeviceCommand =
  | {
      type: 'start';
      channel: Channel;
      strength: number;
      waveform: WaveformDefinition;
      loop: boolean;
    }
  | { type: 'stop'; channel?: Channel }
  | { type: 'adjustStrength'; channel: Channel; delta: number }
  | { type: 'changeWave'; channel: Channel; waveform: WaveformDefinition; loop: boolean }
  | { type: 'burst'; channel: Channel; strength: number; durationMs: number }
  | { type: 'emergencyStop' };

export interface TimerCommand {
  type: 'timer';
  seconds: number;
  label: string;
}

export type ToolExecutionPlan =
  | { type: 'device'; command: DeviceCommand }
  | { type: 'timer'; command: TimerCommand };

export interface DeviceCommandResult {
  state: DeviceState;
  notes?: string[];
}

export type PermissionDecision =
  | { type: 'approve-once' }
  | { type: 'approve-scoped'; expiresAt?: number }
  | { type: 'deny'; reason?: string };

export type PolicyDecision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'clamp'; command: DeviceCommand; reason: string }
  | { type: 'require-confirm'; reason: string };

export type RuntimeEvent =
  | {
      type: 'user-message-accepted';
      sessionId: string;
      message: ConversationMessage;
      sourceType: SourceType;
    }
  | { type: 'assistant-message-delta'; sessionId: string; content: string }
  | { type: 'session-updated'; sessionId: string }
  | {
      type: 'assistant-message-completed';
      sessionId: string;
      message: ConversationMessage;
      sourceType: SourceType;
    }
  | {
      type: 'assistant-message-aborted';
      sessionId: string;
      reason: string;
      message: ConversationMessage;
      sourceType: SourceType;
    }
  | { type: 'tool-call-proposed'; sessionId: string; toolCall: ToolCall }
  | { type: 'timer-scheduled'; sessionId: string; label: string; dueAt: number }
  | { type: 'timer-fired'; sessionId: string; label: string; firedAt: number }
  | { type: 'tool-call-denied'; sessionId: string; toolCall: ToolCall; reason: string }
  | { type: 'tool-call-failed'; sessionId: string; toolCall: ToolCall; error: string }
  | {
      type: 'device-command-executed';
      sessionId: string;
      command: DeviceCommand;
      result: DeviceCommandResult;
    }
  | { type: 'device-state-changed'; state: DeviceState }
  | { type: 'runtime-warning'; sessionId?: string; message: string }
  | {
      type: 'llm-turn-start';
      sessionId: string;
      iteration: number;
      instructions: string;
      messages: Array<{ role: string; content: string; toolCallCount?: number }>;
      toolNames: string[];
    }
  | {
      type: 'llm-turn-complete';
      sessionId: string;
      iteration: number;
      assistantMessage: string;
      toolCalls: ToolCall[];
      rawRequest?: unknown;
      rawResponse?: unknown;
    };

export function createEmptyDeviceState(): DeviceState {
  return {
    connected: false,
    battery: 0,
    strengthA: 0,
    strengthB: 0,
    limitA: 200,
    limitB: 200,
    waveActiveA: false,
    waveActiveB: false,
  };
}

export function isDeviceToolName(name: string): boolean {
  return (
    name === 'start' ||
    name === 'stop' ||
    name === 'adjust_strength' ||
    name === 'change_wave' ||
    name === 'burst' ||
    name === 'emergency_stop'
  );
}

export function createMessage(
  role: MessageRole,
  content: string,
  createdAt = Date.now(),
  options?: Pick<ConversationMessage, 'reasoningContent' | 'toolCalls'>,
): ConversationMessage {
  return {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt,
    reasoningContent: options?.reasoningContent,
    toolCalls: options?.toolCalls ? structuredClone(options.toolCalls) : undefined,
  };
}
