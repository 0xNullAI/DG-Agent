import type { RuntimeEvent } from '@dg-agent/core';
import { createBridgeSessionId } from './bridge-utils.js';
import { MessageQueue } from './message-queue.js';
import type { BridgeLogEntry, BridgeManagerOptions, BridgeManagerStatus, MessageOrigin } from './bridge-types.js';

export class BridgeManager {
  private readonly queue = new MessageQueue((text, origin) => this.processIncoming(text, origin));
  private readonly originBySession = new Map<string, MessageOrigin>();
  private readonly logListeners = new Set<(entry: BridgeLogEntry) => void>();
  private readonly statusListeners = new Set<(status: BridgeManagerStatus) => void>();
  private unsubscribeClient: (() => void) | null = null;
  private started = false;
  private readonly options: BridgeManagerOptions;

  constructor(options: BridgeManagerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    for (const adapter of this.options.adapters) {
      this.options.registry.register(adapter);
      adapter.onMessage((message) => {
        this.emitLog('info', `Incoming ${message.platform}/${message.userName}: ${message.text.slice(0, 80)}`);
        this.queue.enqueue(message.text, {
          platform: message.platform,
          userId: message.userId,
          userName: message.userName,
        });
        this.emitStatus();
      });
      await adapter.start();
      this.emitLog('info', `Adapter ${adapter.platform} started.`);
    }

    this.unsubscribeClient = this.options.client.subscribe((event) => {
      void this.handleClientEvent(event);
    });
    this.emitStatus();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    this.unsubscribeClient?.();
    this.unsubscribeClient = null;

    for (const adapter of this.options.adapters) {
      await adapter.stop();
      this.options.registry.unregister(adapter.platform);
      this.emitLog('info', `Adapter ${adapter.platform} stopped.`);
    }
    this.emitStatus();
  }

  subscribeLogs(listener: (entry: BridgeLogEntry) => void): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  subscribeStatus(listener: (status: BridgeManagerStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): BridgeManagerStatus {
    return {
      started: this.started,
      pendingMessages: this.queue.pending,
      adapters: this.options.adapters.map((adapter) => ({
        platform: adapter.platform,
        connected: adapter.connected,
      })),
    };
  }

  private async processIncoming(text: string, origin: MessageOrigin): Promise<void> {
    const sessionId = createBridgeSessionId(origin);
    this.originBySession.set(sessionId, origin);
    this.emitLog('info', `Routing ${origin.platform}/${origin.userName} into session ${sessionId}.`);
    await this.options.client.sendUserMessage({
      sessionId,
      text,
      context: {
        sessionId,
        sourceType: origin.platform,
        sourceUserId: origin.userId,
        traceId: `bridge-${origin.platform}-${Date.now()}`,
      },
    });
  }

  private async handleClientEvent(event: RuntimeEvent): Promise<void> {
    if (event.type !== 'assistant-message-completed' && event.type !== 'assistant-message-aborted') return;

    const origin = this.originBySession.get(event.sessionId);
    if (!origin) return;

    const adapter = this.options.registry.get(origin.platform);
    if (!adapter) return;

    if (!event.message.content.trim()) return;
    this.emitLog('info', `Outgoing ${origin.platform}/${origin.userName}: ${event.message.content.slice(0, 80)}`);
    await adapter.sendMessage(origin.userId, event.message.content);
  }

  private emitLog(level: BridgeLogEntry['level'], text: string): void {
    const entry: BridgeLogEntry = {
      timestamp: Date.now(),
      level,
      text,
    };
    for (const listener of this.logListeners) {
      listener(entry);
    }
  }

  private emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
