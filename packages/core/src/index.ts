export type Channel = 'A' | 'B';
export type SourceType = 'web' | 'qq' | 'telegram' | 'cli' | 'api' | 'system';
export type MessageRole = 'system' | 'user' | 'assistant';
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
  sourceChannelId?: string;
  traceId: string;
}

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
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
  | { type: 'start'; channel: Channel; strength: number; waveform: WaveformDefinition; loop: boolean }
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
  | { type: 'user-message-accepted'; sessionId: string; message: ConversationMessage }
  | { type: 'assistant-message-delta'; sessionId: string; content: string }
  | { type: 'session-updated'; sessionId: string }
  | { type: 'assistant-message-completed'; sessionId: string; message: ConversationMessage }
  | { type: 'assistant-message-aborted'; sessionId: string; reason: string; message: ConversationMessage }
  | { type: 'tool-call-proposed'; sessionId: string; toolCall: ToolCall }
  | { type: 'timer-scheduled'; sessionId: string; label: string; dueAt: number }
  | { type: 'timer-fired'; sessionId: string; label: string; firedAt: number }
  | { type: 'tool-call-denied'; sessionId: string; toolCall: ToolCall; reason: string }
  | { type: 'tool-call-failed'; sessionId: string; toolCall: ToolCall; error: string }
  | { type: 'device-command-executed'; sessionId: string; command: DeviceCommand; result: DeviceCommandResult }
  | { type: 'device-state-changed'; state: DeviceState }
  | { type: 'runtime-warning'; sessionId?: string; message: string };

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

export function createMessage(role: MessageRole, content: string, createdAt = Date.now()): ConversationMessage {
  return {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt,
  };
}
