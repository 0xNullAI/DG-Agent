import type {
  ActionContext,
  DeviceCommand,
  DeviceCommandResult,
  DeviceState,
  MessageRole,
  PermissionDecision,
  RuntimeTraceEntry,
  SessionSnapshot,
  ToolDefinition,
  ToolCall,
  WaveformDefinition,
} from '@dg-agent/core';

export type LlmConversationItem =
  | { kind: 'message'; role: Exclude<MessageRole, 'system'> | 'system'; content: string }
  | { kind: 'function_call'; callId: string; name: string; argumentsJson: string }
  | { kind: 'function_call_output'; callId: string; output: string };

export interface LlmTurnInput {
  session: SessionSnapshot;
  message: string;
  context: ActionContext;
  instructions: string;
  tools: ToolDefinition[];
  onTextDelta?: (accumulated: string) => void;
  abortSignal?: AbortSignal;
  conversation?: LlmConversationItem[];
}

export interface LlmTurnResult {
  assistantMessage: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
}

export interface DevicePort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): Promise<DeviceState>;
  execute(command: DeviceCommand): Promise<DeviceCommandResult>;
  emergencyStop(): Promise<void>;
  onStateChanged(listener: (state: DeviceState) => void): () => void;
}

export interface LlmPort {
  runTurn(input: LlmTurnInput): Promise<LlmTurnResult>;
}

export interface PermissionRequest {
  context: ActionContext;
  toolName: string;
  toolDisplayName?: string;
  summary: string;
  args: Record<string, unknown>;
}

export interface PermissionPort {
  request(input: PermissionRequest): Promise<PermissionDecision>;
}

export interface SessionStorePort {
  get(sessionId: string): Promise<SessionSnapshot | null>;
  save(session: SessionSnapshot): Promise<void>;
  list(): Promise<SessionSnapshot[]>;
  delete(sessionId: string): Promise<void>;
}

export interface SessionTraceStorePort {
  list(sessionId: string): Promise<RuntimeTraceEntry[]>;
  append(sessionId: string, entry: Omit<RuntimeTraceEntry, 'id' | 'createdAt'>): Promise<RuntimeTraceEntry>;
  clear(sessionId: string): Promise<void>;
}

export interface WaveformLibraryPort {
  getById(id: string): Promise<WaveformDefinition | null>;
  list(): Promise<WaveformDefinition[]>;
}

export interface LoggerPort {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
