import type { PlatformAdapter, PlatformMessage } from "../adapter.js";

export interface QQAdapterConfig {
  wsUrl: string;
  allowUsers: string[];
  allowGroups: string[];
}

interface OneBotMessageEvent {
  post_type: string;
  message_type: string;
  sub_type: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  sender: { user_id: number; nickname: string };
  raw_message: string;
  message: { type: string; data: Record<string, string> }[];
}

interface OneBotResponse {
  status: string;
  retcode: number;
  echo: string;
  data: Record<string, unknown>;
}

type MessageHandler = (msg: PlatformMessage) => void;

interface PendingWaiter {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

const GROUP_PREFIX = "group:";
const RECONNECT_BASE_MS = 3000;
const RECONNECT_CAP_MS = 30000;

export class QQAdapter implements PlatformAdapter {
  readonly platform = "qq";

  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private pendingWaiters = new Map<string, PendingWaiter>();
  private config: QQAdapterConfig;
  private shouldReconnect = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: QQAdapterConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): Promise<void> {
    this.shouldReconnect = true;
    return this.connect();
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log("[QQ] Stopped");
  }

  sendMessage(userId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("[QQ] WebSocket is not connected"));
        return;
      }

      const echo = crypto.randomUUID();
      const isGroup = userId.startsWith(GROUP_PREFIX);

      const payload = isGroup
        ? {
            action: "send_group_msg",
            params: { group_id: Number(userId.slice(GROUP_PREFIX.length)), message: text },
            echo,
          }
        : {
            action: "send_private_msg",
            params: { user_id: Number(userId), message: text },
            echo,
          };

      const onResponse = (ev: MessageEvent) => {
        try {
          const data: OneBotResponse = JSON.parse(ev.data as string);
          if (data.echo !== echo) return;
          this.ws?.removeEventListener("message", onResponse);
          if (data.status === "ok") {
            resolve();
          } else {
            reject(new Error(`[QQ] send failed: retcode=${data.retcode}`));
          }
        } catch {
          // Not our response, ignore parse errors
        }
      };

      this.ws.addEventListener("message", onResponse);
      this.ws.send(JSON.stringify(payload));
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  waitForReply(userId: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const existing = this.pendingWaiters.get(userId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve(""); // resolve old waiter to avoid leak
      }

      const timer = setTimeout(() => {
        this.pendingWaiters.delete(userId);
        resolve(null);
      }, timeoutMs);

      this.pendingWaiters.set(userId, {
        resolve: (text: string) => {
          clearTimeout(timer);
          this.pendingWaiters.delete(userId);
          resolve(text);
        },
        timer,
      });
    });
  }

  // ---- private ----

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      console.log(`[QQ] Connecting to ${this.config.wsUrl}`);
      const ws = new WebSocket(this.config.wsUrl);

      ws.addEventListener("open", () => {
        console.log("[QQ] Connected");
        this.ws = ws;
        this.reconnectDelay = RECONNECT_BASE_MS;
        resolve();
      });

      ws.addEventListener("message", (ev) => {
        this.handleRaw(ev.data as string);
      });

      ws.addEventListener("close", () => {
        console.log("[QQ] Connection closed");
        this.ws = null;
        this.scheduleReconnect();
      });

      ws.addEventListener("error", (ev) => {
        console.log("[QQ] WebSocket error", ev);
        // If we never connected, reject the start() promise
        if (this.ws === null) {
          reject(new Error("[QQ] Failed to connect"));
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    console.log(`[QQ] Reconnecting in ${this.reconnectDelay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // connect failed, bump delay and try again
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_CAP_MS);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_CAP_MS);
  }

  private handleRaw(raw: string): void {
    let data: OneBotMessageEvent;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.post_type !== "message") return;

    const userIdStr = String(data.user_id);
    const groupIdStr = data.group_id != null ? String(data.group_id) : null;

    // Access control
    if (data.message_type === "private") {
      if (!this.config.allowUsers.includes(userIdStr)) return;
    } else if (data.message_type === "group") {
      if (groupIdStr === null || !this.config.allowGroups.includes(groupIdStr)) return;
    } else {
      return;
    }

    const text = data.raw_message;
    const platformUserId =
      data.message_type === "group" ? `${GROUP_PREFIX}${groupIdStr}` : userIdStr;

    const msg: PlatformMessage = {
      platform: this.platform,
      userId: platformUserId,
      userName: data.sender.nickname,
      text,
    };

    // Resolve pending waiter (keyed by the raw user_id so waitForReply works per-user).
    // Consumed by the waiter — don't dispatch to the general handler.
    const waiter = this.pendingWaiters.get(userIdStr);
    if (waiter) {
      waiter.resolve(text);
      return;
    }

    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        console.log("[QQ] Handler error", err);
      }
    }
  }
}
