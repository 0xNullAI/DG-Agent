import type { AgentClient } from '@dg-agent/client';
import type { PermissionPort } from '@dg-agent/contracts';

export type BridgePlatform = 'qq' | 'telegram';
export type BridgePermissionMode = 'confirm' | 'allow-all';

export interface BridgePlatformMessage {
  platform: BridgePlatform;
  userId: string;
  userName: string;
  text: string;
}

export interface PlatformAdapter {
  readonly platform: BridgePlatform;
  readonly connected: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(userId: string, text: string): Promise<void>;
  onMessage(handler: (message: BridgePlatformMessage) => void): void;
  waitForReply(userId: string, timeoutMs: number): Promise<string | null>;
}

export interface MessageOrigin {
  platform: BridgePlatform;
  userId: string;
  userName: string;
}

export interface BridgeSettings {
  enabled: boolean;
  qq: {
    enabled: boolean;
    wsUrl: string;
    allowUsers: string[];
    allowGroups: string[];
    permissionMode: BridgePermissionMode;
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    proxyUrl: string;
    allowUsers: string[];
    permissionMode: BridgePermissionMode;
  };
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  enabled: false,
  qq: {
    enabled: false,
    wsUrl: 'ws://localhost:3001',
    allowUsers: [],
    allowGroups: [],
    permissionMode: 'confirm',
  },
  telegram: {
    enabled: false,
    botToken: '',
    proxyUrl: '',
    allowUsers: [],
    permissionMode: 'confirm',
  },
};

export interface BridgePermissionPortOptions {
  settings: BridgeSettings;
  fallback: PermissionPort;
  registry: BridgeAdapterRegistry;
  confirmTimeoutMs?: number;
}

export interface BridgeManagerOptions {
  client: AgentClient;
  registry: BridgeAdapterRegistry;
  adapters: PlatformAdapter[];
}

export interface BridgeLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface BridgeManagerStatus {
  started: boolean;
  pendingMessages: number;
  adapters: Array<{ platform: BridgePlatform; connected: boolean }>;
}

export class BridgeAdapterRegistry {
  private readonly adapters = new Map<BridgePlatform, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  unregister(platform: BridgePlatform): void {
    this.adapters.delete(platform);
  }

  get(platform: BridgePlatform): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  all(): PlatformAdapter[] {
    return [...this.adapters.values()];
  }
}
