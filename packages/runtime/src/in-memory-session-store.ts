import type { SessionStorePort } from '@dg-agent/contracts';
import type { SessionSnapshot } from '@dg-agent/core';

export class InMemorySessionStore implements SessionStorePort {
  private readonly sessions = new Map<string, SessionSnapshot>();

  async get(sessionId: string): Promise<SessionSnapshot | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(session: SessionSnapshot): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async list(): Promise<SessionSnapshot[]> {
    return [...this.sessions.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
