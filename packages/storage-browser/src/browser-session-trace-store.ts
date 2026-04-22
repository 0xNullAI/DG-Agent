import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import type { SessionTraceStore } from '@dg-agent/contracts';
import type { RuntimeTraceEntry } from '@dg-agent/core';
import { SESSION_TRACE_KEY_PREFIX } from './browser-settings-constants.js';

export interface BrowserSessionTraceStoreOptions {
  dbName?: string;
  storeName?: string;
}

const TRACE_LIMIT = 500;

export class BrowserSessionTraceStore implements SessionTraceStore {
  private readonly store: UseStore;

  constructor(options: BrowserSessionTraceStoreOptions = {}) {
    this.store = createStore(
      options.dbName ?? 'dg-agent-traces',
      options.storeName ?? 'session-traces',
    );
  }

  async list(sessionId: string): Promise<RuntimeTraceEntry[]> {
    return (await get<RuntimeTraceEntry[]>(this.key(sessionId), this.store)) ?? [];
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
    const current = await this.list(sessionId);
    await set(this.key(sessionId), [...current, next].slice(-TRACE_LIMIT), this.store);
    return next;
  }

  async clear(sessionId: string): Promise<void> {
    await del(this.key(sessionId), this.store);
  }

  private key(sessionId: string): string {
    return `${SESSION_TRACE_KEY_PREFIX}${sessionId}`;
  }
}
