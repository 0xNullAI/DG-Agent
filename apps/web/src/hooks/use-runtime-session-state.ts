import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentClient } from '@dg-agent/client';
import type { RuntimeEvent, SessionSnapshot } from '@dg-agent/core';
import { createSessionId } from '../utils/app-runtime-helpers.js';

export interface UseRuntimeSessionStateOptions {
  client: AgentClient;
  enabled: boolean;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
}

export function useRuntimeSessionState(options: UseRuntimeSessionStateOptions) {
  const { client, enabled, onRuntimeEvent } = options;
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [savedSessions, setSavedSessions] = useState<SessionSnapshot[]>([]);
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [streamingAssistantText, setStreamingAssistantText] = useState('');
  const onRuntimeEventRef = useRef(onRuntimeEvent);
  const syncRequestIdRef = useRef(0);

  useEffect(() => {
    onRuntimeEventRef.current = onRuntimeEvent;
  }, [onRuntimeEvent]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const clearStreamingAssistantText = useCallback(() => {
    setStreamingAssistantText('');
  }, []);

  const refreshCurrentSession = useCallback(
    async (sessionId = activeSessionId): Promise<void> => {
      if (!sessionId) return;

      const [currentSession, sessions] = await Promise.all([client.getSessionSnapshot(sessionId), client.listSessions()]);
      setSession(currentSession);
      setSavedSessions(sessions);
      setDeviceConnected(currentSession.deviceState.connected);
    },
    [activeSessionId, client],
  );

  useEffect(() => {
    if (!enabled) return;

    let active = true;

    async function bootstrap(): Promise<void> {
      const sessions = await client.listSessions();
      if (!active) return;

      setSavedSessions(sessions);
      setActiveSessionId((current) => current ?? sessions[0]?.id ?? createSessionId());
    }

    void bootstrap();

    return () => {
      active = false;
    };
  }, [client, enabled]);

  useEffect(() => {
    if (!enabled || !activeSessionId) return;

    let active = true;
    const sessionId = activeSessionId;

    async function syncCurrentSession(): Promise<void> {
      const requestId = ++syncRequestIdRef.current;
      const [currentSession, sessions] = await Promise.all([client.getSessionSnapshot(sessionId), client.listSessions()]);

      if (!active || requestId !== syncRequestIdRef.current) return;

      setSession(currentSession);
      setSavedSessions(sessions);
      setDeviceConnected(currentSession.deviceState.connected);
    }

    void syncCurrentSession();

    const unsubscribe = client.subscribe((event) => {
      setEvents((current) => [event, ...current].slice(0, 20));

      if (event.type === 'assistant-message-delta') {
        setStreamingAssistantText(event.content);
      }

      if (event.type === 'assistant-message-completed' || event.type === 'assistant-message-aborted') {
        setStreamingAssistantText('');
      }

      if (event.type === 'device-state-changed') {
        setDeviceConnected(event.state.connected);
      }

      onRuntimeEventRef.current?.(event);
      void syncCurrentSession();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeSessionId, client, enabled]);

  return {
    activeSessionId,
    setActiveSessionId,
    events,
    clearEvents,
    session,
    setSession,
    savedSessions,
    setSavedSessions,
    deviceConnected,
    setDeviceConnected,
    streamingAssistantText,
    clearStreamingAssistantText,
    setStreamingAssistantText,
    refreshCurrentSession,
  };
}
