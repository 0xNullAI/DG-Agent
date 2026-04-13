/**
 * bridge/index.ts — Social platform bridge entry point.
 *
 * Initializes platform adapters (QQ, Telegram), routes incoming messages
 * to the AI conversation, and forwards AI responses back to the originating
 * platform. All code runs in the browser.
 */

import type { AgentSink } from '../types';
import type { PlatformAdapter, PlatformMessage } from './adapter';
import { MessageQueue, type MessageOrigin } from './queue';
import { QQAdapter, type QQAdapterConfig } from './adapters/qq';
import { TelegramAdapter, type TelegramConfig } from './adapters/telegram';
import { requestPermissionRemote } from './permission-bridge';
import type { PermissionChoice } from '../agent/permissions';

// ---------------------------------------------------------------------------
// Bridge settings (stored in localStorage via AppSettings.bridge)
// ---------------------------------------------------------------------------

export interface BridgeSettings {
  enabled: boolean;
  qq: {
    enabled: boolean;
    wsUrl: string;
    allowUsers: string[];
    allowGroups: string[];
    permissionMode: 'ask' | 'always';
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    proxyUrl: string;
    allowUsers: number[];
    permissionMode: 'ask' | 'always';
  };
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  enabled: false,
  qq: {
    enabled: false,
    wsUrl: 'ws://localhost:3001',
    allowUsers: [],
    allowGroups: [],
    permissionMode: 'ask',
  },
  telegram: {
    enabled: false,
    botToken: '',
    proxyUrl: '',
    allowUsers: [],
    permissionMode: 'ask',
  },
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const adapters: PlatformAdapter[] = [];
let queue: MessageQueue | null = null;

/** The origin of the currently-processing bridge turn, if any. */
let currentOrigin: (MessageOrigin & { adapter: PlatformAdapter }) | null = null;


// ---------------------------------------------------------------------------
// BridgeSink — AgentSink implementation that forwards to social platforms
// ---------------------------------------------------------------------------

/** Accumulated text for the current streamed response. */
let accumulatedText = '';

export const bridgeSink: AgentSink = {
  onTextDelta(accumulated: string): void {
    accumulatedText = accumulated;
  },

  onTextComplete(): void {
    if (currentOrigin && accumulatedText) {
      const { adapter, userId } = currentOrigin;
      const text = accumulatedText;
      adapter.sendMessage(userId, text).catch((err) => {
        console.error('[Bridge] Failed to send response:', err);
      });
    }
    accumulatedText = '';
  },

  onTextDiscard(): void {
    accumulatedText = '';
  },

  onTextInline(text: string): void {
    if (!text || !currentOrigin) return;
    const { adapter, userId } = currentOrigin;
    adapter.sendMessage(userId, text).catch((err) => {
      console.error('[Bridge] Failed to send inline message:', err);
    });
  },

  onToolCall(name: string, _args: Record<string, unknown>, result: string): void {
    if (!currentOrigin) return;
    const { adapter, userId } = currentOrigin;
    const msg = `[工具] ${name}: ${result}`;
    adapter.sendMessage(userId, msg).catch((err) => {
      console.error('[Bridge] Failed to send tool notification:', err);
    });
  },
};

// ---------------------------------------------------------------------------
// Permission request for bridge-originated turns
// ---------------------------------------------------------------------------

/**
 * Request permission for a tool call from the remote user.
 * Returns 'allow' or 'deny'. Used by conversation.ts when the turn
 * originated from a bridge message.
 */
export async function requestBridgePermission(
  toolName: string,
  args: Record<string, unknown>,
): Promise<PermissionChoice> {
  if (!currentOrigin) return 'deny';

  const { adapter, userId, platform } = currentOrigin;

  // Check per-platform permission mode from settings
  const settings = loadBridgeSettings();
  const platformSettings = platform === 'qq' ? settings.qq : settings.telegram;
  if (platformSettings.permissionMode === 'always') return 'always';

  return requestPermissionRemote(adapter, userId, toolName, args);
}

// ---------------------------------------------------------------------------
// Bridge origin tracking
// ---------------------------------------------------------------------------

/** Get the current bridge message origin (null if the current turn is from the browser UI). */
export function getCurrentOrigin(): (MessageOrigin & { adapter: PlatformAdapter }) | null {
  return currentOrigin;
}

/** Check if the current turn originated from the bridge. */
export function isBridgeTurn(): boolean {
  return currentOrigin !== null;
}

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

/**
 * Start the bridge with the given settings and message processor.
 * The processor is `conversation.sendMessage` — called for each incoming
 * platform message after the queue serializes them.
 */
export async function initBridge(
  processor: (text: string) => Promise<void>,
): Promise<void> {
  const settings = loadBridgeSettings();
  if (!settings.enabled) {
    console.log('[Bridge] Disabled, skipping init.');
    return;
  }

  queue = new MessageQueue(async (text, origin) => {
    const adapter = findAdapter(origin.platform);
    if (!adapter) return;
    currentOrigin = { ...origin, adapter };
    try {
      await processor(text);
    } finally {
      currentOrigin = null;
      accumulatedText = '';
    }
  });

  // QQ adapter
  if (settings.qq.enabled && settings.qq.wsUrl) {
    const config: QQAdapterConfig = {
      wsUrl: settings.qq.wsUrl,
      allowUsers: settings.qq.allowUsers,
      allowGroups: settings.qq.allowGroups,
    };
    const qq = new QQAdapter(config);
    qq.onMessage(handleIncomingMessage);
    adapters.push(qq);
    try {
      await qq.start();
    } catch (err) {
      console.error('[Bridge] QQ adapter failed to start:', err);
    }
  }

  // Telegram adapter
  if (settings.telegram.enabled && settings.telegram.botToken) {
    const config: TelegramConfig = {
      botToken: settings.telegram.botToken,
      proxyUrl: settings.telegram.proxyUrl || undefined,
      allowUsers: settings.telegram.allowUsers,
    };
    const tg = new TelegramAdapter(config);
    tg.onMessage(handleIncomingMessage);
    adapters.push(tg);
    try {
      await tg.start();
    } catch (err) {
      console.error('[Bridge] Telegram adapter failed to start:', err);
    }
  }

  console.log(`[Bridge] Initialized with ${adapters.length} adapter(s).`);
}

/** Stop all adapters and clean up. */
export async function stopBridge(): Promise<void> {
  for (const adapter of adapters) {
    try {
      await adapter.stop();
    } catch (err) {
      console.error(`[Bridge] Failed to stop ${adapter.platform}:`, err);
    }
  }
  adapters.length = 0;
  queue = null;
  currentOrigin = null;
}

/** Get adapter connection status for display. */
export function getAdapterStatus(): Array<{ platform: string; connected: boolean }> {
  return adapters.map((a) => ({ platform: a.platform, connected: a.connected }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function handleIncomingMessage(msg: PlatformMessage): void {
  if (!queue) return;
  console.log(`[Bridge] Incoming from ${msg.platform}/${msg.userName}: ${msg.text.slice(0, 50)}`);
  queue.enqueue(msg.text, {
    platform: msg.platform,
    userId: msg.userId,
    userName: msg.userName,
  });
}

function findAdapter(platform: string): PlatformAdapter | undefined {
  return adapters.find((a) => a.platform === platform);
}

function loadBridgeSettings(): BridgeSettings {
  try {
    const raw = localStorage.getItem('dg-agent-settings');
    if (!raw) return DEFAULT_BRIDGE_SETTINGS;
    const settings = JSON.parse(raw);
    return settings.bridge || DEFAULT_BRIDGE_SETTINGS;
  } catch {
    return DEFAULT_BRIDGE_SETTINGS;
  }
}
