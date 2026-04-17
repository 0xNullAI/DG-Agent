import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval';
import type { SessionStorePort } from '@dg-agent/contracts';
import type { SessionSnapshot } from '@dg-agent/core';
import { SESSION_KEY_PREFIX } from './browser-settings-constants.js';

export interface BrowserSessionStoreOptions {
  dbName?: string;
  storeName?: string;
}

export class BrowserSessionStore implements SessionStorePort {
  private readonly store: UseStore;

  constructor(options: BrowserSessionStoreOptions = {}) {
    this.store = createStore(options.dbName ?? 'dg-agent-rewrite', options.storeName ?? 'sessions');
  }

  async get(sessionId: string): Promise<SessionSnapshot | null> {
    return (await get<SessionSnapshot>(this.key(sessionId), this.store)) ?? null;
  }

  async save(session: SessionSnapshot): Promise<void> {
    await set(this.key(session.id), session, this.store);
  }

  async list(): Promise<SessionSnapshot[]> {
    const allEntries = await entries<string, SessionSnapshot>(this.store);
    return allEntries
      .filter(([key]) => key.startsWith(SESSION_KEY_PREFIX))
      .map(([, session]) => session)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async delete(sessionId: string): Promise<void> {
    await del(this.key(sessionId), this.store);
  }

  private key(sessionId: string): string {
    return `${SESSION_KEY_PREFIX}${sessionId}`;
  }
}
