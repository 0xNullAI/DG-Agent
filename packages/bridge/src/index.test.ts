import { describe, expect, it } from 'vitest';
import type { AgentClient } from '@dg-agent/client';
import type { PermissionRequest } from '@dg-agent/core';
import {
  createEmptyDeviceState,
  createMessage,
  type RuntimeEvent,
  type RuntimeTraceEntry,
  type SessionSnapshot,
} from '@dg-agent/core';
import {
  BridgeAdapterRegistry,
  BridgeManager,
  BridgePermissionService,
  MessageQueue,
  type PlatformAdapter,
} from './index.js';
import type { BridgePlatformMessage } from './index.js';

class FakePermissionService {
  calls: PermissionRequest[] = [];

  async request(input: PermissionRequest) {
    this.calls.push(input);
    return { type: 'approve-once' } as const;
  }
}

class FakeAdapter implements PlatformAdapter {
  private handler: ((message: BridgePlatformMessage) => void) | null = null;
  private replyQueue: Array<string | null> = [];

  readonly sentMessages: Array<{ userId: string; text: string }> = [];
  readonly platform = 'telegram' as const;
  connected = false;

  async start(): Promise<void> {
    this.connected = true;
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    this.sentMessages.push({ userId, text });
  }

  onMessage(handler: (message: BridgePlatformMessage) => void): void {
    this.handler = handler;
  }

  waitForReply(_userId: string, _timeoutMs: number): Promise<string | null> {
    return Promise.resolve(this.replyQueue.shift() ?? null);
  }

  queueReply(reply: string | null): void {
    this.replyQueue.push(reply);
  }

  emitIncoming(text: string, userId = 'user-1', userName = 'Alice'): void {
    this.handler?.({
      platform: this.platform,
      userId,
      userName,
      text,
    });
  }
}

class SlowStartAdapter extends FakeAdapter {
  startCalls = 0;
  stopCalls = 0;
  private resolveStart: (() => void) | null = null;
  private startGate = new Promise<void>((resolve) => {
    this.resolveStart = resolve;
  });

  override async start(): Promise<void> {
    this.startCalls += 1;
    await this.startGate;
    this.connected = true;
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    this.connected = false;
  }

  finishStart(): void {
    this.resolveStart?.();
  }
}

class FakeAgentClient implements AgentClient {
  readonly transport = 'embedded' as const;
  readonly supportsLiveEvents = true;
  readonly sentMessages: Array<{
    sessionId: string;
    text: string;
    context: { sessionId: string; sourceType: string; sourceUserId?: string; traceId: string };
  }> = [];
  private listener: ((event: RuntimeEvent) => void) | null = null;
  private readonly sessions = new Map<string, SessionSnapshot>();

  async listSessions(): Promise<SessionSnapshot[]> {
    return [];
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return (
      this.sessions.get(sessionId) ?? {
        id: sessionId,
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        deviceState: createEmptyDeviceState(),
      }
    );
  }

  async getSessionTrace(_sessionId: string): Promise<RuntimeTraceEntry[]> {
    return [];
  }

  async deleteSession(): Promise<void> {}

  async connectDevice(): Promise<void> {}

  async disconnectDevice(): Promise<void> {}

  async emergencyStop(): Promise<void> {}

  async abortCurrentReply(): Promise<void> {}

  async sendUserMessage(input: {
    sessionId: string;
    text: string;
    context: { sessionId: string; sourceType: string; sourceUserId?: string; traceId: string };
  }): Promise<void> {
    this.sentMessages.push(input);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: {
    type: 'assistant-message-completed' | 'assistant-message-aborted';
    sessionId: string;
    message: ReturnType<typeof createMessage>;
    sourceType: 'web' | 'qq' | 'telegram' | 'cli' | 'api' | 'system';
    reason?: string;
  }): void {
    this.listener?.(event as RuntimeEvent);
  }

  setSessionMetadata(sessionId: string, metadata: Record<string, unknown>): void {
    this.sessions.set(sessionId, {
      id: sessionId,
      createdAt: 0,
      updatedAt: 0,
      messages: [],
      deviceState: createEmptyDeviceState(),
      metadata,
    });
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('bridge-core', () => {
  it('processes queued messages sequentially', async () => {
    const order: string[] = [];
    const queue = new MessageQueue(async (text) => {
      order.push(`start:${text}`);
      await Promise.resolve();
      order.push(`end:${text}`);
    });

    queue.enqueue('one', { platform: 'telegram', userId: '1', userName: 'a' });
    queue.enqueue('two', { platform: 'telegram', userId: '1', userName: 'a' });
    await flushAsyncWork();

    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it('uses the fallback permission service for non-bridge sources', async () => {
    const fallback = new FakePermissionService();
    const port = new BridgePermissionService({
      settings: {
        enabled: true,
        qq: {
          enabled: false,
          wsUrl: '',
          accessToken: '',
          allowUsers: [],
          allowGroups: [],
          permissionMode: 'confirm',
        },
        telegram: {
          enabled: true,
          botToken: 'bot',
          proxyUrl: '',
          allowUsers: ['user-1'],
          permissionMode: 'confirm',
        },
      },
      fallback,
      registry: new BridgeAdapterRegistry(),
    });

    const decision = await port.request({
      context: {
        sessionId: 'session-1',
        sourceType: 'web',
        traceId: 'trace-1',
      },
      toolName: 'start',
      summary: 'Start channel A',
      args: {},
    });

    expect(decision).toEqual({ type: 'approve-once' });
    expect(fallback.calls).toHaveLength(1);
  });

  it('caches scoped bridge permissions after a remote approval', async () => {
    const adapter = new FakeAdapter();
    adapter.queueReply('3');

    const registry = new BridgeAdapterRegistry();
    registry.register(adapter);

    const port = new BridgePermissionService({
      settings: {
        enabled: true,
        qq: {
          enabled: false,
          wsUrl: '',
          accessToken: '',
          allowUsers: [],
          allowGroups: [],
          permissionMode: 'confirm',
        },
        telegram: {
          enabled: true,
          botToken: 'bot',
          proxyUrl: '',
          allowUsers: ['user-1'],
          permissionMode: 'confirm',
        },
      },
      fallback: new FakePermissionService(),
      registry,
    });

    const request: PermissionRequest = {
      context: {
        sessionId: 'bridge:telegram:user-1',
        sourceType: 'telegram',
        sourceUserId: 'user-1',
        traceId: 'trace-bridge',
      },
      toolName: 'start',
      summary: 'Start channel A',
      args: { channel: 'A' },
    };

    const first = await port.request(request);
    const sentAfterFirst = adapter.sentMessages.length;
    const second = await port.request(request);

    expect(first.type).toBe('approve-scoped');
    expect(second.type).toBe('approve-scoped');
    expect(adapter.sentMessages).toHaveLength(sentAfterFirst);
  });

  it('routes incoming messages to the client and relays assistant replies back out', async () => {
    const adapter = new FakeAdapter();
    const registry = new BridgeAdapterRegistry();
    const client = new FakeAgentClient();
    const manager = new BridgeManager({
      client,
      registry,
      adapters: [adapter],
    });

    await manager.start();
    adapter.emitIncoming('hello from telegram');
    await flushAsyncWork();

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.sessionId).toBe('bridge:telegram:user-1');
    expect(client.sentMessages[0]?.context.sourceType).toBe('telegram');

    client.emit({
      type: 'assistant-message-completed',
      sessionId: 'bridge:telegram:user-1',
      message: createMessage('assistant', 'reply back'),
      sourceType: 'telegram',
    });
    await flushAsyncWork();

    expect(adapter.sentMessages.at(-1)).toEqual({
      userId: 'user-1',
      text: 'reply back',
    });

    await manager.stop();
    expect(registry.get('telegram')).toBeUndefined();
  });

  it('does not duplicate incoming message handling after restarting the same bridge manager', async () => {
    const adapter = new FakeAdapter();
    const registry = new BridgeAdapterRegistry();
    const client = new FakeAgentClient();
    const manager = new BridgeManager({
      client,
      registry,
      adapters: [adapter],
    });

    await manager.start();
    await manager.stop();
    await manager.start();

    adapter.emitIncoming('hello once');
    await flushAsyncWork();

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.text).toBe('hello once');
  });

  it('does not let an old adapter unregister a newer adapter for the same platform', () => {
    const registry = new BridgeAdapterRegistry();
    const oldAdapter = new FakeAdapter();
    const newAdapter = new FakeAdapter();

    registry.register(oldAdapter);
    registry.register(newAdapter);
    registry.unregister('telegram', oldAdapter);

    expect(registry.get('telegram')).toBe(newAdapter);
  });

  it('routes incoming bridge messages to the resolved active session when provided', async () => {
    const adapter = new FakeAdapter();
    const registry = new BridgeAdapterRegistry();
    const client = new FakeAgentClient();
    const manager = new BridgeManager({
      client,
      registry,
      adapters: [adapter],
      resolveTargetSessionId: async () => 'active-session',
    });

    await manager.start();
    adapter.emitIncoming('hello current session');
    await flushAsyncWork();

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.sessionId).toBe('active-session');
    expect(client.sentMessages[0]?.text).toBe('hello current session');
  });

  it('coalesces start-stop-start churn while startup is still in flight', async () => {
    const adapter = new SlowStartAdapter();
    const registry = new BridgeAdapterRegistry();
    const client = new FakeAgentClient();
    const manager = new BridgeManager({
      client,
      registry,
      adapters: [adapter],
    });

    const firstStart = manager.start();
    const stop = manager.stop();
    const secondStart = manager.start();

    expect(adapter.startCalls).toBe(1);
    expect(adapter.stopCalls).toBe(0);

    adapter.finishStart();
    await Promise.all([firstStart, stop, secondStart]);

    expect(adapter.startCalls).toBe(1);
    expect(adapter.stopCalls).toBe(0);
    expect(adapter.connected).toBe(true);
    expect(manager.getStatus().started).toBe(true);
  });

  it('recovers the bridge reply target from persisted session metadata after a manager rebuild', async () => {
    const adapter = new FakeAdapter();
    const registry = new BridgeAdapterRegistry();
    const client = new FakeAgentClient();
    client.setSessionMetadata('active-session', {
      bridgeOrigin: {
        platform: 'telegram',
        userId: 'user-1',
        userName: 'Alice',
      },
    });

    const manager = new BridgeManager({
      client,
      registry,
      adapters: [adapter],
    });

    await manager.start();
    client.emit({
      type: 'assistant-message-completed',
      sessionId: 'active-session',
      message: createMessage('assistant', 'reply after rebuild'),
      sourceType: 'telegram',
    });
    await flushAsyncWork();

    expect(adapter.sentMessages.at(-1)).toEqual({
      userId: 'user-1',
      text: 'reply after rebuild',
    });
  });

  it('does not relay web-originated replies from a bridge-bound session back to the adapter', async () => {
    const adapter = new FakeAdapter();
    const registry = new BridgeAdapterRegistry();
    const client = new FakeAgentClient();
    client.setSessionMetadata('active-session', {
      bridgeOrigin: {
        platform: 'telegram',
        userId: 'user-1',
        userName: 'Alice',
      },
    });

    const manager = new BridgeManager({
      client,
      registry,
      adapters: [adapter],
    });

    await manager.start();
    client.emit({
      type: 'assistant-message-completed',
      sessionId: 'active-session',
      message: createMessage('assistant', 'stay in chat only'),
      sourceType: 'web',
    });
    await flushAsyncWork();

    expect(adapter.sentMessages).toHaveLength(0);
  });
});
