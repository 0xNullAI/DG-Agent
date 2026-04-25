/// <reference types="node" />

import assert from 'node:assert/strict';
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
  type BridgePlatformMessage,
  type PlatformAdapter,
} from './index.js';

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

  emit(event: RuntimeEvent): void {
    this.listener?.(event);
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

async function testMessageQueue(): Promise<void> {
  const order: string[] = [];
  const queue = new MessageQueue(async (text) => {
    order.push(`start:${text}`);
    await Promise.resolve();
    order.push(`end:${text}`);
  });

  queue.enqueue('one', { platform: 'telegram', userId: '1', userName: 'a' });
  queue.enqueue('two', { platform: 'telegram', userId: '1', userName: 'a' });
  await flushAsyncWork();

  assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two']);
}

async function testFallbackPermission(): Promise<void> {
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

  assert.deepEqual(decision, { type: 'approve-once' });
  assert.equal(fallback.calls.length, 1);
}

async function testScopedRemotePermissionCaching(): Promise<void> {
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

  assert.equal(first.type, 'approve-scoped');
  assert.equal(second.type, 'approve-scoped');
  assert.equal(adapter.sentMessages.length, sentAfterFirst);
}

async function testBridgeManagerRoundTrip(): Promise<void> {
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

  assert.equal(client.sentMessages.length, 1);
  assert.equal(client.sentMessages[0]?.sessionId, 'bridge:telegram:user-1');
  assert.equal(client.sentMessages[0]?.context.sourceType, 'telegram');

  client.emit({
    type: 'assistant-message-completed',
    sessionId: 'bridge:telegram:user-1',
    message: createMessage('assistant', 'reply back'),
    sourceType: 'telegram',
  });
  await flushAsyncWork();

  assert.deepEqual(adapter.sentMessages.at(-1), {
    userId: 'user-1',
    text: 'reply back',
  });

  await manager.stop();
  assert.equal(registry.get('telegram'), undefined);
}

async function testBridgeManagerRestartDoesNotDuplicateIncomingMessages(): Promise<void> {
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

  assert.equal(client.sentMessages.length, 1);
  assert.equal(client.sentMessages[0]?.text, 'hello once');
}

async function testRegistryIgnoresStaleUnregister(): Promise<void> {
  const registry = new BridgeAdapterRegistry();
  const oldAdapter = new FakeAdapter();
  const newAdapter = new FakeAdapter();

  registry.register(oldAdapter);
  registry.register(newAdapter);
  registry.unregister('telegram', oldAdapter);

  assert.equal(registry.get('telegram'), newAdapter);
}

async function testBridgeManagerUsesResolvedActiveSession(): Promise<void> {
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

  assert.equal(client.sentMessages.length, 1);
  assert.equal(client.sentMessages[0]?.sessionId, 'active-session');
  assert.equal(client.sentMessages[0]?.text, 'hello current session');
}

async function testBridgeManagerCoalescesStartStopStartWhileStarting(): Promise<void> {
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

  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 0);

  adapter.finishStart();
  await Promise.all([firstStart, stop, secondStart]);

  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 0);
  assert.equal(adapter.connected, true);
  assert.equal(manager.getStatus().started, true);
}

async function testBridgeManagerRecoversPersistedReplyTarget(): Promise<void> {
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

  assert.deepEqual(adapter.sentMessages.at(-1), {
    userId: 'user-1',
    text: 'reply after rebuild',
  });
}

async function testBridgeManagerDoesNotRelayWebRepliesFromBridgeBoundSessions(): Promise<void> {
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

  assert.equal(adapter.sentMessages.length, 0);
}

await testMessageQueue();
await testFallbackPermission();
await testScopedRemotePermissionCaching();
await testBridgeManagerRoundTrip();
await testBridgeManagerRestartDoesNotDuplicateIncomingMessages();
await testRegistryIgnoresStaleUnregister();
await testBridgeManagerUsesResolvedActiveSession();
await testBridgeManagerCoalescesStartStopStartWhileStarting();
await testBridgeManagerRecoversPersistedReplyTarget();
await testBridgeManagerDoesNotRelayWebRepliesFromBridgeBoundSessions();
console.log('bridge-core self-test passed');
