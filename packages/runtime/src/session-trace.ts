import type { SessionTraceStorePort } from '@dg-agent/contracts';
import type { RuntimeTraceEntry } from '@dg-agent/core';

const TRACE_LIMIT = 500;

export class InMemorySessionTraceStore implements SessionTraceStorePort {
  private readonly traces = new Map<string, RuntimeTraceEntry[]>();

  async list(sessionId: string): Promise<RuntimeTraceEntry[]> {
    return (this.traces.get(sessionId) ?? []).map((entry) => ({ ...entry }));
  }

  async append(
    sessionId: string,
    entry: Omit<RuntimeTraceEntry, 'id' | 'createdAt'>,
  ): Promise<RuntimeTraceEntry> {
    const createdAt = Date.now();
    const next: RuntimeTraceEntry = {
      id: `trace-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt,
      ...entry,
    };

    const current = this.traces.get(sessionId) ?? [];
    this.traces.set(sessionId, [...current, next].slice(-TRACE_LIMIT));
    return { ...next };
  }

  async clear(sessionId: string): Promise<void> {
    this.traces.delete(sessionId);
  }
}
