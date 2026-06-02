import {
  createEmptyDeviceState,
  type ConversationMessage,
  type MessageRole,
  type SessionSnapshot,
  type ToolCall,
} from '@dg-agent/core';

/**
 * Chat history import/export.
 *
 * The wire format follows the OpenTelemetry GenAI semantic conventions for
 * messages (https://opentelemetry.io/docs/specs/semconv/gen-ai/): each turn is
 * a `{ role, parts }` object and tool calls are `tool_call` parts. That makes
 * an export readable by anything that speaks the OTel GenAI vocabulary.
 *
 * To stay lossless on a DG-Agent → DG-Agent round-trip we additionally stash
 * the original snapshot fields (message ids, timestamps, device state, …) under
 * an `_dg` extension. On import we prefer `_dg` when present and otherwise
 * reconstruct a best-effort snapshot from the OTel parts alone, so foreign OTel
 * files can still be imported.
 */

const SCHEMA_ID = 'dg-agent.chat-export';
const SCHEMA_VERSION = 1;
const GEN_AI_SYSTEM = 'dg-agent';

type OtelPart =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> };

interface OtelMessage {
  role: MessageRole | 'tool';
  parts: OtelPart[];
}

interface ExportedSession {
  'gen_ai.conversation.id': string;
  'gen_ai.system': string;
  createdAt: number;
  updatedAt: number;
  messages: OtelMessage[];
  /** DG-Agent extension: lossless original payload for round-tripping. */
  _dg: {
    messages: ConversationMessage[];
    deviceState: SessionSnapshot['deviceState'];
    metadata?: Record<string, unknown>;
  };
}

export interface ChatExportDocument {
  schema: typeof SCHEMA_ID;
  schemaVersion: number;
  semconv: 'opentelemetry/gen_ai';
  exportedAt: number;
  sessions: ExportedSession[];
}

function messageToOtel(message: ConversationMessage): OtelMessage {
  const parts: OtelPart[] = [];
  if (message.reasoningContent) {
    parts.push({ type: 'reasoning', content: message.reasoningContent });
  }
  if (message.content) {
    parts.push({ type: 'text', content: message.content });
  }
  for (const call of message.toolCalls ?? []) {
    parts.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.args });
  }
  return { role: message.role, parts };
}

function sessionToExported(session: SessionSnapshot): ExportedSession {
  return {
    'gen_ai.conversation.id': session.id,
    'gen_ai.system': GEN_AI_SYSTEM,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages.map(messageToOtel),
    _dg: {
      messages: session.messages,
      deviceState: session.deviceState,
      metadata: session.metadata,
    },
  };
}

export function buildExportDocument(
  sessions: SessionSnapshot[],
  exportedAt: number,
): ChatExportDocument {
  return {
    schema: SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    semconv: 'opentelemetry/gen_ai',
    exportedAt,
    sessions: sessions.map(sessionToExported),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function reconstructMessagesFromOtel(
  messages: OtelMessage[],
  baseTime: number,
): ConversationMessage[] {
  return messages.map((message, index) => {
    const role: MessageRole = message.role === 'tool' ? 'assistant' : message.role;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const content = parts
      .filter((part): part is Extract<OtelPart, { type: 'text' }> => part?.type === 'text')
      .map((part) => part.content)
      .join('\n');
    const reasoning = parts
      .filter(
        (part): part is Extract<OtelPart, { type: 'reasoning' }> => part?.type === 'reasoning',
      )
      .map((part) => part.content)
      .join('\n');
    const toolCalls: ToolCall[] = parts
      .filter(
        (part): part is Extract<OtelPart, { type: 'tool_call' }> => part?.type === 'tool_call',
      )
      .map((part, callIndex) => ({
        id: part.id || `imported-${index}-${callIndex}`,
        name: part.name,
        args: isRecord(part.arguments) ? part.arguments : {},
      }));

    const createdAt = baseTime + index;
    return {
      id: `${createdAt}-imported-${index}`,
      role,
      content,
      createdAt,
      ...(reasoning ? { reasoningContent: reasoning } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  });
}

function exportedToSession(entry: ExportedSession): SessionSnapshot {
  const id = entry['gen_ai.conversation.id'];
  if (typeof id !== 'string' || !id) {
    throw new Error('会话缺少有效的 id');
  }
  const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : Date.now();
  const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : createdAt;

  const dg = entry._dg;
  if (dg && Array.isArray(dg.messages)) {
    return {
      id,
      createdAt,
      updatedAt,
      messages: dg.messages,
      deviceState: dg.deviceState ?? createEmptyDeviceState(),
      ...(dg.metadata ? { metadata: dg.metadata } : {}),
    };
  }

  const messages = Array.isArray(entry.messages)
    ? reconstructMessagesFromOtel(entry.messages, createdAt)
    : [];
  return {
    id,
    createdAt,
    updatedAt,
    messages,
    deviceState: createEmptyDeviceState(),
  };
}

/**
 * Parse an exported document (as a JSON string) into session snapshots ready to
 * hand to `client.importSessions`. Throws a Chinese-language error when the
 * payload is not a recognizable export.
 */
export function parseImportDocument(json: string): SessionSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }

  if (!isRecord(parsed) || parsed.schema !== SCHEMA_ID) {
    throw new Error('文件不是 DG-Agent 聊天记录导出文件');
  }
  if (!Array.isArray(parsed.sessions)) {
    throw new Error('导出文件缺少会话列表');
  }

  return (parsed.sessions as unknown[]).map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('会话条目格式无效');
    }
    return exportedToSession(entry as unknown as ExportedSession);
  });
}

export const CHAT_EXPORT_SCHEMA_ID = SCHEMA_ID;
