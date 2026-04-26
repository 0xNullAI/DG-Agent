import type { RuntimeEvent, ToolCall } from '@dg-agent/core';

const STORAGE_KEY = 'dg-agent.model-logs';

export interface ModelLogTurn {
  id: string;
  sessionId: string;
  iteration: number;
  startedAt: number;
  completedAt?: number;
  request?: {
    instructions: string;
    messages: Array<{ role: string; content: string; toolCallCount?: number }>;
    toolNames: string[];
    rawRequest?: unknown;
  };
  response?: {
    assistantMessage: string;
    toolCalls: ToolCall[];
    rawResponse?: unknown;
  };
}

function turnKey(sessionId: string, iteration: number): string {
  return `${sessionId}::${iteration}`;
}

export function loadModelLogs(): ModelLogTurn[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ModelLogTurn[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(turns: ModelLogTurn[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(turns));
  } catch {
    // storage full or unavailable — silently drop
  }
}

export function clearModelLogs(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function appendModelLogEvent(current: ModelLogTurn[], event: RuntimeEvent): ModelLogTurn[] {
  if (event.type !== 'llm-turn-start' && event.type !== 'llm-turn-complete') {
    return current;
  }

  const key = turnKey(event.sessionId, event.iteration);
  const existingIndex = current.findIndex(
    (t) => turnKey(t.sessionId, t.iteration) === key && t.completedAt === undefined,
  );

  if (event.type === 'llm-turn-start') {
    const turn: ModelLogTurn = {
      id: `${key}::${Date.now()}`,
      sessionId: event.sessionId,
      iteration: event.iteration,
      startedAt: Date.now(),
      request: {
        instructions: event.instructions,
        messages: event.messages,
        toolNames: event.toolNames,
      },
    };
    const next =
      existingIndex >= 0
        ? current.map((t, i) => (i === existingIndex ? { ...t, ...turn, id: t.id } : t))
        : [...current, turn];
    persist(next);
    return next;
  }

  if (existingIndex < 0) {
    const orphan: ModelLogTurn = {
      id: `${key}::${Date.now()}`,
      sessionId: event.sessionId,
      iteration: event.iteration,
      startedAt: Date.now(),
      completedAt: Date.now(),
      response: {
        assistantMessage: event.assistantMessage,
        toolCalls: event.toolCalls,
        rawResponse: event.rawResponse,
      },
    };
    const next = [...current, orphan];
    persist(next);
    return next;
  }

  const next = current.map((t, i) =>
    i === existingIndex
      ? {
          ...t,
          completedAt: Date.now(),
          request: t.request
            ? { ...t.request, rawRequest: event.rawRequest }
            : { instructions: '', messages: [], toolNames: [], rawRequest: event.rawRequest },
          response: {
            assistantMessage: event.assistantMessage,
            toolCalls: event.toolCalls,
            rawResponse: event.rawResponse,
          },
        }
      : t,
  );
  persist(next);
  return next;
}
