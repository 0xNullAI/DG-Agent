import {
  createEmptyDeviceState,
  type ConversationMessage,
  type MessageRole,
  type SessionSnapshot,
  type ToolCall,
} from '@dg-agent/core';
import { getSessionTitle } from './ui-formatters.js';

/**
 * Chat history import/export.
 *
 * Each session is exported as its own JSON file (the app then zips them
 * together). The on-disk shape follows the OpenTelemetry GenAI semantic
 * conventions as closely as is meaningful here
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/):
 *
 *   - `gen_ai.conversation.id`   — the session id
 *   - `gen_ai.provider.name`     — who produced the trace ("dg-agent")
 *   - `gen_ai.input.messages`    — the turn list, each `{ role, parts }`,
 *                                  with the standard `text` / `tool_call` part
 *                                  types and roles system/user/assistant/tool
 *
 * DG-Agent does not capture per-call telemetry (token usage, per-operation
 * spans), so this is the GenAI *message* vocabulary rather than a full OTLP
 * record. Anything outside that vocabulary — original message ids, timestamps,
 * reasoning text, device state, bridge metadata — lives under the `_dg`
 * extension so a DG-Agent → DG-Agent round-trip stays lossless. On import we
 * prefer `_dg` and fall back to reconstructing from the standard messages, so
 * a plain GenAI-shaped file (no `_dg`) still imports.
 */

const SCHEMA_ID = 'dg-agent.chat-export';
const SCHEMA_VERSION = 2;
const PROVIDER_NAME = 'dg-agent';

type OtelTextPart = { type: 'text'; content: string };
type OtelToolCallPart = {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
type OtelPart = OtelTextPart | OtelToolCallPart;

interface OtelMessage {
  role: MessageRole | 'tool';
  parts: OtelPart[];
}

interface DgExtension {
  schema: typeof SCHEMA_ID;
  schemaVersion: number;
  exportedAt: number;
  createdAt: number;
  updatedAt: number;
  deviceState: SessionSnapshot['deviceState'];
  metadata?: Record<string, unknown>;
  /** Original messages, verbatim — preserves ids, reasoning, tool-call args. */
  messages: ConversationMessage[];
}

export interface SessionExportFile {
  'gen_ai.conversation.id': string;
  'gen_ai.provider.name': string;
  'gen_ai.input.messages': OtelMessage[];
  _dg: DgExtension;
}

function messageToOtel(message: ConversationMessage): OtelMessage {
  const parts: OtelPart[] = [];
  if (message.content) {
    parts.push({ type: 'text', content: message.content });
  }
  for (const call of message.toolCalls ?? []) {
    parts.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.args });
  }
  return { role: message.role, parts };
}

export function buildSessionFile(session: SessionSnapshot, exportedAt: number): SessionExportFile {
  return {
    'gen_ai.conversation.id': session.id,
    'gen_ai.provider.name': PROVIDER_NAME,
    'gen_ai.input.messages': session.messages.map(messageToOtel),
    _dg: {
      schema: SCHEMA_ID,
      schemaVersion: SCHEMA_VERSION,
      exportedAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      deviceState: session.deviceState,
      messages: session.messages,
      ...(session.metadata ? { metadata: session.metadata } : {}),
    },
  };
}

export function serializeSessionFile(session: SessionSnapshot, exportedAt: number): string {
  return JSON.stringify(buildSessionFile(session, exportedAt), null, 2);
}

/** A filesystem-safe `<title>-<shortid>.json` name for a session's export file. */
export function sessionFileName(session: SessionSnapshot): string {
  const safeTitle =
    getSessionTitle(session)
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 40) || 'session';
  return `${safeTitle}-${session.id.slice(-8)}.json`;
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
      .filter((part): part is OtelTextPart => part?.type === 'text')
      .map((part) => part.content)
      .join('\n');
    const toolCalls: ToolCall[] = parts
      .filter((part): part is OtelToolCallPart => part?.type === 'tool_call')
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
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  });
}

/**
 * Reconstruct one session from an exported object. Handles both the per-session
 * file shape (v2) and a single entry of the legacy multi-session document (v1):
 * both carry `gen_ai.conversation.id` and a `_dg` block, only differing in where
 * the timestamps live.
 */
function reconstructSession(entry: Record<string, unknown>): SessionSnapshot {
  const id = entry['gen_ai.conversation.id'];
  if (typeof id !== 'string' || !id) {
    throw new Error('会话缺少有效的 id');
  }

  const dg = isRecord(entry._dg) ? (entry._dg as Partial<DgExtension>) : undefined;
  const createdAt =
    typeof dg?.createdAt === 'number'
      ? dg.createdAt
      : typeof entry.createdAt === 'number'
        ? entry.createdAt
        : Date.now();
  const updatedAt =
    typeof dg?.updatedAt === 'number'
      ? dg.updatedAt
      : typeof entry.updatedAt === 'number'
        ? entry.updatedAt
        : createdAt;
  const deviceState = dg?.deviceState ?? createEmptyDeviceState();
  const metadata = dg?.metadata ?? (isRecord(entry.metadata) ? entry.metadata : undefined);

  let messages: ConversationMessage[];
  if (dg && Array.isArray(dg.messages)) {
    messages = dg.messages;
  } else {
    const otel = entry['gen_ai.input.messages'] ?? entry.messages;
    messages = Array.isArray(otel)
      ? reconstructMessagesFromOtel(otel as OtelMessage[], createdAt)
      : [];
  }

  return {
    id,
    createdAt,
    updatedAt,
    messages,
    deviceState,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Parse one exported JSON string into session snapshots. Accepts a per-session
 * file (v2), a single legacy multi-session document (v1), and throws a
 * Chinese-language error otherwise.
 */
export function parseSessionsFromJson(json: string): SessionSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }

  if (!isRecord(parsed)) {
    throw new Error('文件不是 DG-Agent 聊天记录文件');
  }

  // Legacy v1: one document holding a `sessions` array.
  if (parsed.schema === SCHEMA_ID && Array.isArray(parsed.sessions)) {
    return (parsed.sessions as unknown[]).map((entry) => {
      if (!isRecord(entry)) throw new Error('会话条目格式无效');
      return reconstructSession(entry);
    });
  }

  // v2: one file per session.
  if (typeof parsed['gen_ai.conversation.id'] === 'string') {
    return [reconstructSession(parsed)];
  }

  throw new Error('文件不是 DG-Agent 聊天记录文件');
}
