import type { BridgePlatformMessage, PlatformAdapter } from '@dg-agent/bridge-core';
import type { BridgeSettings } from '@dg-agent/bridge-core';

const GROUP_PREFIX = 'group:';

export interface QQAdapterConfig {
  wsUrl: string;
  allowUsers: string[];
  allowGroups: string[];
}

interface OneBotMessageEvent {
  post_type: string;
  message_type: string;
  user_id: number;
  group_id?: number;
  sender: { user_id: number; nickname: string };
  raw_message: string;
  self_id?: number;
}

interface OneBotResponse {
  status: string;
  retcode: number;
  echo?: string;
}

export class QQAdapter implements PlatformAdapter {
  readonly platform = 'qq' as const;
  private ws: WebSocket | null = null;
  private handlers: Array<(message: BridgePlatformMessage) => void> = [];
  private waiters = new Map<string, { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }>();
  private selfId: string | null = null;

  constructor(private readonly config: QQAdapterConfig) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    if (this.connected) return;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl);
      ws.addEventListener('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('message', (event) => {
        this.handleRaw(event.data as string);
      });
      ws.addEventListener('error', () => reject(new Error('QQ WebSocket connection failed.')));
      ws.addEventListener('close', () => {
        this.ws = null;
      });
    });
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('QQ adapter is not connected.');
    }

    const echo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isGroup = userId.startsWith(GROUP_PREFIX);
    const payload = isGroup
      ? {
          action: 'send_group_msg',
          params: { group_id: Number(userId.slice(GROUP_PREFIX.length)), message: text },
          echo,
        }
      : {
          action: 'send_private_msg',
          params: { user_id: Number(userId), message: text },
          echo,
        };

    this.ws.send(JSON.stringify(payload));
  }

  onMessage(handler: (message: BridgePlatformMessage) => void): void {
    this.handlers.push(handler);
  }

  waitForReply(userId: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const existing = this.waiters.get(userId);
      if (existing) {
        clearTimeout(existing.timer);
      }

      const timer = setTimeout(() => {
        this.waiters.delete(userId);
        resolve(null);
      }, timeoutMs);

      this.waiters.set(userId, {
        resolve: (text: string) => {
          clearTimeout(timer);
          this.waiters.delete(userId);
          resolve(text);
        },
        timer,
      });
    });
  }

  private handleRaw(raw: string): void {
    let data: OneBotMessageEvent | OneBotResponse;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if ('post_type' in data) {
      if (!this.selfId && data.self_id) {
        this.selfId = String(data.self_id);
      }
      if (data.post_type !== 'message') return;

      const userId = String(data.user_id);
      const groupId = data.group_id != null ? String(data.group_id) : null;
      const isPrivate = data.message_type === 'private';

      if (isPrivate) {
        if (!this.config.allowUsers.includes(userId)) return;
      } else {
        if (!groupId || !this.config.allowGroups.includes(groupId)) return;
        if (!this.isAtBot(data.raw_message)) return;
      }

      const text = this.stripAtBot(data.raw_message).trim();
      if (!text) return;

      const waiter = this.waiters.get(userId);
      if (waiter) {
        waiter.resolve(text);
        return;
      }

      const message: BridgePlatformMessage = {
        platform: this.platform,
        userId: isPrivate ? userId : `${GROUP_PREFIX}${groupId}`,
        userName: data.sender.nickname,
        text,
      };

      for (const handler of this.handlers) {
        handler(message);
      }
    }
  }

  private isAtBot(rawMessage: string): boolean {
    if (!this.selfId) return false;
    return rawMessage.includes(`[CQ:at,qq=${this.selfId}]`);
  }

  private stripAtBot(rawMessage: string): string {
    if (!this.selfId) return rawMessage;
    return rawMessage.replace(new RegExp(`\\[CQ:at,qq=${this.selfId}\\]`, 'g'), '').trim();
  }
}

export interface TelegramAdapterConfig {
  botToken: string;
  proxyUrl?: string;
  allowUsers: string[];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const;
  private running = false;
  private lastPollOk = false;
  private lastOffset = 0;
  private handler: ((message: BridgePlatformMessage) => void) | null = null;
  private waiters = new Map<string, (text: string) => void>();

  constructor(private readonly config: TelegramAdapterConfig) {}

  get connected(): boolean {
    return this.running && this.lastPollOk;
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      const response = await fetch(`${this.apiUrl('getUpdates')}?offset=-1&limit=1`);
      if (response.ok) {
        const data = (await response.json()) as TelegramResponse<TelegramUpdate[]>;
        const latest = data.result.at(-1);
        if (data.ok && latest) {
          this.lastOffset = latest.update_id + 1;
        }
      }
    } catch {
      // Ignore startup catch-up failures and continue into long polling.
    }
    this.running = true;
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    const url = this.apiUrl('sendMessage');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: Number(userId),
        text,
      }),
    });

    if (!response.ok) {
      return;
    }
  }

  onMessage(handler: (message: BridgePlatformMessage) => void): void {
    this.handler = handler;
  }

  waitForReply(userId: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(userId);
        resolve(null);
      }, timeoutMs);

      this.waiters.set(userId, (text: string) => {
        clearTimeout(timer);
        this.waiters.delete(userId);
        resolve(text);
      });
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const url = `${this.apiUrl('getUpdates')}?offset=${this.lastOffset}&timeout=25`;
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 30_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(abortTimer);
        const data = (await response.json()) as TelegramResponse<TelegramUpdate[]>;
        if (!data.ok) {
          this.lastPollOk = false;
          await delay(5000);
          continue;
        }

        this.lastPollOk = true;

        for (const update of data.result) {
          this.lastOffset = update.update_id + 1;
          const message = update.message;
          const from = message?.from;
          if (!message?.text || !from) continue;
          if (!this.config.allowUsers.includes(String(from.id))) continue;

          const waiter = this.waiters.get(String(from.id));
          if (waiter) {
            waiter(message.text);
            continue;
          }

          this.handler?.({
            platform: this.platform,
            userId: String(from.id),
            userName: from.username ?? from.first_name ?? String(from.id),
            text: message.text,
          });
        }
      } catch {
        if (!this.running) break;
        this.lastPollOk = false;
        await delay(5000);
      }
    }
  }

  private apiUrl(method: string): string {
    const prefix = this.config.proxyUrl?.replace(/\/+$/, '') ?? 'https://api.telegram.org';
    return `${prefix}/bot${this.config.botToken}/${method}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBrowserBridgeAdapters(settings: BridgeSettings): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [];

  if (settings.enabled && settings.qq.enabled && settings.qq.wsUrl) {
    adapters.push(
      new QQAdapter({
        wsUrl: settings.qq.wsUrl,
        allowUsers: settings.qq.allowUsers,
        allowGroups: settings.qq.allowGroups,
      }),
    );
  }

  if (settings.enabled && settings.telegram.enabled && settings.telegram.botToken) {
    adapters.push(
      new TelegramAdapter({
        botToken: settings.telegram.botToken,
        proxyUrl: settings.telegram.proxyUrl || undefined,
        allowUsers: settings.telegram.allowUsers,
      }),
    );
  }

  return adapters;
}
