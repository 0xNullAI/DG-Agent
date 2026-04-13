import type { PlatformAdapter, PlatformMessage } from '../adapter.js';

export interface TelegramConfig {
  botToken: string;
  proxyUrl?: string;
  allowUsers: number[];
}

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram';

  private token: string;
  private proxy: string | undefined;
  private allowUsers: Set<number>;

  private running = false;
  private lastPollOk = false;
  private lastOffset = 0;

  private handler: ((msg: PlatformMessage) => void) | null = null;
  private waiters = new Map<string, (text: string) => void>();

  constructor(config: TelegramConfig) {
    this.token = config.botToken;
    this.proxy = config.proxyUrl;
    this.allowUsers = new Set(config.allowUsers);
  }

  get connected(): boolean {
    return this.running && this.lastPollOk;
  }

  /** Build the full API URL for a given method, routing through proxy if configured. */
  private apiUrl(method: string): string {
    const base = this.proxy
      ? `${this.proxy}/bot${this.token}`
      : `https://api.telegram.org/bot${this.token}`;
    return `${base}/${method}`;
  }

  async start(): Promise<void> {
    console.log('[Telegram] Starting adapter...');

    // Skip old updates by fetching the latest one
    try {
      const url = this.apiUrl('getUpdates') + '?offset=-1&limit=1';
      const resp = await fetch(url);
      const data: TelegramResponse<TelegramUpdate[]> = await resp.json();
      if (data.ok && data.result.length > 0) {
        this.lastOffset = data.result[data.result.length - 1].update_id + 1;
      }
    } catch (err) {
      console.log('[Telegram] Warning: failed to skip old updates:', err);
    }

    this.running = true;
    console.log('[Telegram] Adapter started, beginning poll loop.');
    this.pollLoop();
  }

  async stop(): Promise<void> {
    console.log('[Telegram] Stopping adapter...');
    this.running = false;
  }

  onMessage(handler: (msg: PlatformMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    const url = this.apiUrl('sendMessage');
    const body = JSON.stringify({
      chat_id: Number(userId),
      text,
      parse_mode: 'Markdown',
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.log(`[Telegram] sendMessage failed (${resp.status}): ${errText}`);
    }
  }

  waitForReply(userId: string, timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
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

  // ── internal ──────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const url =
          this.apiUrl('getUpdates') +
          `?offset=${this.lastOffset}&timeout=25`;

        // AbortController timeout slightly longer than the long-poll timeout
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 30_000);

        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(abortTimer);

        const data: TelegramResponse<TelegramUpdate[]> = await resp.json();

        if (!data.ok) {
          console.log('[Telegram] getUpdates returned ok=false');
          this.lastPollOk = false;
          await this.delay(5000);
          continue;
        }

        this.lastPollOk = true;

        for (const update of data.result) {
          this.lastOffset = update.update_id + 1;

          const msg = update.message;
          if (!msg?.text || !msg.from) continue;
          if (!this.allowUsers.has(msg.from.id)) continue;

          const platformMsg: PlatformMessage = {
            platform: this.platform,
            userId: String(msg.from.id),
            userName: msg.from.username ?? msg.from.first_name,
            text: msg.text,
          };

          // Resolve any pending waitForReply first
          const waiter = this.waiters.get(platformMsg.userId);
          if (waiter) {
            waiter(platformMsg.text);
            continue; // consumed by waiter, don't dispatch to general handler
          }

          if (this.handler) {
            try {
              this.handler(platformMsg);
            } catch (err) {
              console.log('[Telegram] Error in message handler:', err);
            }
          }
        }
      } catch (err) {
        this.lastPollOk = false;
        if (!this.running) break;
        console.log('[Telegram] Poll error, retrying in 5s:', err);
        await this.delay(5000);
      }
    }

    console.log('[Telegram] Poll loop ended.');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
