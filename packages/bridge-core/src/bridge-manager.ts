import { getBridgeOriginMetadata, type RuntimeEvent } from '@dg-agent/core';
import { createBridgeSessionId } from './bridge-utils.js';
import { MessageQueue } from './message-queue.js';
import type {
  BridgeLogEntry,
  BridgeManagerOptions,
  BridgeManagerStatus,
  MessageOrigin,
  PlatformAdapter,
} from './bridge-types.js';

type AdapterMessageHandler = (message: {
  platform: MessageOrigin['platform'];
  userId: string;
  userName: string;
  text: string;
}) => void;

export class BridgeManager {
  private readonly queue = new MessageQueue((text, origin) => this.processIncoming(text, origin));
  private readonly originBySession = new Map<string, MessageOrigin>();
  private readonly adapterMessageBindings = new Map<PlatformAdapter, AdapterMessageHandler>();
  private readonly logListeners = new Set<(entry: BridgeLogEntry) => void>();
  private readonly statusListeners = new Set<(status: BridgeManagerStatus) => void>();
  private unsubscribeClient: (() => void) | null = null;
  private started = false;
  private desiredStarted = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly options: BridgeManagerOptions;

  constructor(options: BridgeManagerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.desiredStarted = true;

    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.started) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    const startPromise = this.performStart();
    this.startPromise = startPromise;

    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    }
  }

  async stop(): Promise<void> {
    this.desiredStarted = false;

    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Ignore startup failures during shutdown.
      }
    }
    if (this.desiredStarted || !this.started) return;
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    const stopPromise = this.performStop();
    this.stopPromise = stopPromise;

    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    }
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

  private async performStart(): Promise<void> {
    if (this.started) return;

    this.started = true;
    this.emitLog('info', '桥接管理器启动中');

    const startedAdapters: PlatformAdapter[] = [];

    try {
      if (this.options.adapters.length === 0) {
        this.emitLog('warn', '桥接已启用，但当前没有可用的桥接通道，请检查 QQ 或 Telegram 配置');
      }

      for (const adapter of this.options.adapters) {
        this.options.registry.register(adapter);
        this.bindAdapterMessages(adapter);

        this.emitLog('info', `正在连接 ${adapter.platform} 桥接`);
        await adapter.start();
        startedAdapters.push(adapter);
        this.emitLog('info', `${adapter.platform} 桥接已连接`);
        this.emitStatus();
      }

      this.unsubscribeClient = this.options.client.subscribe((event) => {
        void this.handleClientEvent(event);
      });
      this.emitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '未知错误');
      this.emitLog('error', `桥接启动失败：${message}`);
      await this.stopStartedAdapters(startedAdapters);
      this.started = false;
      this.emitStatus();
      throw error;
    }
  }

  private async performStop(): Promise<void> {
    if (!this.started) return;

    this.started = false;
    this.unsubscribeClient?.();
    this.unsubscribeClient = null;

    for (const adapter of this.options.adapters) {
      await adapter.stop();
      this.options.registry.unregister(adapter.platform, adapter);
      this.emitLog('info', `${adapter.platform} 桥接已停止`);
    }
    this.emitStatus();
  }

  private async processIncoming(text: string, origin: MessageOrigin): Promise<void> {
    const sessionId =
      (await this.options.resolveTargetSessionId?.(origin)) ?? createBridgeSessionId(origin);
    this.originBySession.set(sessionId, origin);
    this.emitLog('info', `正在把 ${origin.platform}/${origin.userName} 路由到会话 ${sessionId}`);
    await this.options.client.sendUserMessage({
      sessionId,
      text,
      context: {
        sessionId,
        sourceType: origin.platform,
        sourceUserId: origin.userId,
        sourceUserName: origin.userName,
        traceId: `bridge-${origin.platform}-${Date.now()}`,
      },
    });
  }

  private async handleClientEvent(event: RuntimeEvent): Promise<void> {
    if (event.type !== 'assistant-message-completed' && event.type !== 'assistant-message-aborted')
      return;
    if (event.sourceType !== 'qq' && event.sourceType !== 'telegram') return;

    const origin =
      this.originBySession.get(event.sessionId) ??
      (await this.loadOriginFromSession(event.sessionId));
    if (!origin) {
      if (event.sessionId.startsWith('bridge:')) {
        this.emitLog('warn', `桥接会话 ${event.sessionId} 缺少来源映射，无法回发消息`);
      }
      return;
    }

    this.originBySession.set(event.sessionId, origin);

    const adapter = this.options.registry.get(origin.platform);
    if (!adapter) {
      this.emitLog('warn', `找不到 ${origin.platform} 桥接适配器，无法回发给 ${origin.userName}`);
      return;
    }

    if (!event.message.content.trim()) {
      this.emitLog('warn', `桥接会话 ${event.sessionId} 的回复为空，已跳过回发`);
      return;
    }

    this.emitLog(
      'info',
      `准备发送给 ${origin.platform}/${origin.userName}：${event.message.content.slice(0, 80)}`,
    );
    try {
      await adapter.sendMessage(origin.userId, event.message.content);
      this.emitLog('info', `已发送给 ${origin.platform}/${origin.userName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '未知错误');
      this.emitLog('error', `发送给 ${origin.platform}/${origin.userName} 失败：${message}`);
    }
  }

  private async loadOriginFromSession(sessionId: string): Promise<MessageOrigin | null> {
    try {
      const session = await this.options.client.getSessionSnapshot(sessionId);
      const persisted = getBridgeOriginMetadata(session.metadata);
      if (!persisted) return null;
      return {
        platform: persisted.platform,
        userId: persisted.userId,
        userName: persisted.userName ?? persisted.userId,
      };
    } catch {
      return null;
    }
  }

  private async stopStartedAdapters(startedAdapters: PlatformAdapter[]): Promise<void> {
    for (const adapter of startedAdapters.reverse()) {
      try {
        await adapter.stop();
      } catch {
        // Ignore rollback failures.
      }
      this.options.registry.unregister(adapter.platform, adapter);
    }
    this.unsubscribeClient?.();
    this.unsubscribeClient = null;
  }

  private bindAdapterMessages(adapter: PlatformAdapter): void {
    if (this.adapterMessageBindings.has(adapter)) {
      return;
    }

    const handler: AdapterMessageHandler = (message) => {
      this.emitLog(
        'info',
        `收到 ${message.platform}/${message.userName} 的消息：${message.text.slice(0, 80)}`,
      );
      this.queue.enqueue(message.text, {
        platform: message.platform,
        userId: message.userId,
        userName: message.userName,
      });
      this.emitStatus();
    };

    adapter.onMessage(handler);
    this.adapterMessageBindings.set(adapter, handler);
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
