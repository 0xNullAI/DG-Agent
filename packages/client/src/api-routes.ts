import type { ActionContext, SessionSnapshot } from '@dg-agent/core';

export const apiRoutes = {
  health: '/health',
  sessions: '/sessions',
  session(sessionId: string): string {
    return `/sessions/${sessionId}`;
  },
  connect(sessionId: string): string {
    return `/sessions/${sessionId}/connect`;
  },
  messages(sessionId: string): string {
    return `/sessions/${sessionId}/messages`;
  },
  stop(sessionId: string): string {
    return `/sessions/${sessionId}/stop`;
  },
} as const;

export interface HealthResponse {
  ok: true;
}

export interface ConnectDeviceResponse {
  ok: true;
}

export interface SendMessageRequest {
  text: string;
  context?: ActionContext;
}

export type SessionResponse = SessionSnapshot;
export type SessionsResponse = SessionSnapshot[];
export interface DeleteSessionResponse {
  ok: true;
}
