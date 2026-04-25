import {
  apiRoutes,
  type ConnectDeviceResponse,
  type DeleteSessionResponse,
  type SendMessageRequest,
  type SessionResponse,
  type SessionsResponse,
} from './api-routes.js';

export * from './api-routes.js';
import type { RuntimeEvent, RuntimeTraceEntry, SessionSnapshot } from '@dg-agent/core';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type SendUserMessageInput,
} from '@dg-agent/runtime';

export interface AgentClient {
  readonly transport: 'embedded' | 'http';
  readonly supportsLiveEvents: boolean;
  listSessions(): Promise<SessionSnapshot[]>;
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot>;
  getSessionTrace(sessionId: string): Promise<RuntimeTraceEntry[]>;
  deleteSession(sessionId: string): Promise<void>;
  connectDevice(sessionId?: string): Promise<void>;
  disconnectDevice(): Promise<void>;
  emergencyStop(sessionId: string): Promise<void>;
  abortCurrentReply(sessionId: string): Promise<void>;
  sendUserMessage(input: SendUserMessageInput): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

class EmbeddedAgentClient implements AgentClient {
  readonly transport = 'embedded' as const;
  readonly supportsLiveEvents = true;

  constructor(private readonly runtime: AgentRuntime) {}

  listSessions(): Promise<SessionSnapshot[]> {
    return this.runtime.listSessions();
  }

  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.runtime.getSessionSnapshot(sessionId);
  }

  getSessionTrace(sessionId: string): Promise<RuntimeTraceEntry[]> {
    return this.runtime.getSessionTrace(sessionId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.runtime.deleteSession(sessionId);
  }

  connectDevice(_sessionId?: string): Promise<void> {
    return this.runtime.connectDevice();
  }

  disconnectDevice(): Promise<void> {
    return this.runtime.disconnectDevice();
  }

  emergencyStop(sessionId: string): Promise<void> {
    return this.runtime.emergencyStop(sessionId);
  }

  abortCurrentReply(sessionId: string): Promise<void> {
    return this.runtime.abortCurrentReply(sessionId);
  }

  sendUserMessage(input: SendUserMessageInput): Promise<void> {
    return this.runtime.sendUserMessage(input);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.runtime.subscribe(listener);
  }
}

export function createEmbeddedAgentClient(options: AgentRuntimeOptions): AgentClient {
  return new EmbeddedAgentClient(new AgentRuntime(options));
}

export interface HttpAgentClientOptions {
  baseUrl: string;
}

export class HttpAgentClient implements AgentClient {
  readonly transport = 'http' as const;
  readonly supportsLiveEvents = false;

  constructor(private readonly options: HttpAgentClientOptions) {}

  async listSessions(): Promise<SessionSnapshot[]> {
    return this.request<SessionsResponse>(apiRoutes.sessions);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.request<SessionResponse>(apiRoutes.session(sessionId));
  }

  async getSessionTrace(_sessionId: string): Promise<RuntimeTraceEntry[]> {
    return [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<DeleteSessionResponse>(apiRoutes.session(sessionId), {
      method: 'DELETE',
    });
  }

  async connectDevice(sessionId = 'default'): Promise<void> {
    await this.request<ConnectDeviceResponse>(apiRoutes.connect(sessionId), {
      method: 'POST',
    });
  }

  async disconnectDevice(): Promise<void> {
    return Promise.resolve();
  }

  async emergencyStop(sessionId: string): Promise<void> {
    await this.request<SessionResponse>(apiRoutes.stop(sessionId), {
      method: 'POST',
    });
  }

  async abortCurrentReply(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  async sendUserMessage(input: SendUserMessageInput): Promise<void> {
    const body: SendMessageRequest = {
      text: input.text,
      context: input.context,
    };

    await this.request<SessionResponse>(apiRoutes.messages(input.sessionId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  subscribe(_listener: (event: RuntimeEvent) => void): () => void {
    return () => undefined;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(path, this.options.baseUrl), init);
    if (!response.ok) {
      throw new Error(`请求失败：HTTP ${response.status}，路径 ${path}`);
    }
    return (await response.json()) as T;
  }
}
