/**
 * @dg-agent/core
 *
 * Shared types live in @dg-kit/core (published, version-pinned). This package
 * re-exports them and adds the agent-runtime-only contracts that DG-Agent
 * needs but DG-MCP / DG-Chat don't (LLM client, session store, permission
 * service, runtime trace, etc.).
 */

export * from '@dg-kit/core';

import type {
  DeviceCommand,
  DeviceCommandResult,
  DeviceState,
  ToolCall,
  ToolDefinition,
} from '@dg-kit/core';

// ============================================================================
// Agent-only types (not shared with DG-MCP / DG-Chat)
// ============================================================================

export type SourceType = 'web' | 'qq' | 'telegram' | 'cli' | 'api' | 'system';
export type MessageRole = 'system' | 'user' | 'assistant';
export type ModelContextStrategy = 'last-user-turn' | 'last-five-user-turns' | 'full-history';

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

// ============================================================================
// Agent-only contract interfaces
// ============================================================================

export type LlmConversationItem =
  | {
      kind: 'message';
      role: Exclude<MessageRole, 'system'> | 'system';
      content: string;
      reasoningContent?: string;
      toolCalls?: ToolCall[];
    }
  | { kind: 'function_call'; callId: string; name: string; argumentsJson: string }
  | { kind: 'function_call_output'; callId: string; output: string };

export interface LlmTurnInput {
  session: SessionSnapshot;
  message: string;
  context: ActionContext;
  instructions: string;
  tools: ToolDefinition[];
  onTextDelta?: (accumulated: string) => void;
  onRawRequest?: (body: unknown) => void;
  abortSignal?: AbortSignal;
  conversation?: LlmConversationItem[];
}

export interface LlmTurnResult {
  assistantMessage: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
  rawResponse?: unknown;
}

export interface LlmClient {
  runTurn(input: LlmTurnInput): Promise<LlmTurnResult>;
}

export interface PermissionRequest {
  context: ActionContext;
  toolName: string;
  toolDisplayName?: string;
  summary: string;
  args: Record<string, unknown>;
}

export interface PermissionService {
  request(input: PermissionRequest): Promise<PermissionDecision>;
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionSnapshot | null>;
  save(session: SessionSnapshot): Promise<void>;
  list(): Promise<SessionSnapshot[]>;
  delete(sessionId: string): Promise<void>;
}

export interface SessionTraceStore {
  list(sessionId: string): Promise<RuntimeTraceEntry[]>;
  append(
    sessionId: string,
    entry: Omit<RuntimeTraceEntry, 'id' | 'createdAt'>,
  ): Promise<RuntimeTraceEntry>;
  clear(sessionId: string): Promise<void>;
}
