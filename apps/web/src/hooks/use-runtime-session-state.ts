import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentClient } from '@dg-agent/client';
import {
  createEmptyDeviceState,
  type DeviceState,
  type RuntimeEvent,
  type RuntimeTraceEntry,
  type SessionSnapshot,
} from '@dg-agent/core';

export interface UseRuntimeSessionStateOptions {
  client: AgentClient;
  enabled: boolean;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
}

export function isActiveRuntimeSessionEvent(event: RuntimeEvent, sessionId: string): boolean {
  return !('sessionId' in event) || event.sessionId === sessionId;
}

export function shouldClearStreamingForEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'session-updated' ||
    event.type === 'assistant-message-completed' ||
    event.type === 'assistant-message-aborted'
  );
}

export function shouldRefreshSessionForEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'user-message-accepted' ||
    event.type === 'session-updated' ||
    event.type === 'assistant-message-completed' ||
    event.type === 'assistant-message-aborted'
  );
}

export function useRuntimeSessionState(options: UseRuntimeSessionStateOptions) {
  const { client, enabled, onRuntimeEvent } = options;
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [sessionTrace, setSessionTrace] = useState<RuntimeTraceEntry[]>([]);
  const [savedSessions, setSavedSessions] = useState<SessionSnapshot[]>([]);
  const [liveDeviceState, setLiveDeviceState] = useState<DeviceState>(createEmptyDeviceState());
  const [replyBusy, setReplyBusy] = useState(false);
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

  const refreshSavedSessions = useCallback(async (): Promise<void> => {
    const sessions = await client.listSessions();
    setSavedSessions(sessions);
  }, [client]);

  const refreshCurrentSession = useCallback(
    async (sessionId = activeSessionId): Promise<void> => {
      if (!sessionId) return;

      const [currentSession, currentTrace, sessions] = await Promise.all([
        client.getSessionSnapshot(sessionId),
        client.getSessionTrace(sessionId),
        client.listSessions(),
      ]);
      setSession(currentSession);
      setSessionTrace(currentTrace);
      setSavedSessions(sessions);
      setLiveDeviceState(currentSession.deviceState);
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
      const firstId = sessions[0]?.id;
      if (firstId) {
        setActiveSessionId((current) => current ?? firstId);
      } else {
        const newId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        setActiveSessionId((current) => current ?? newId);
      }
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
    setReplyBusy(false);

    async function syncCurrentSession(): Promise<void> {
      const requestId = ++syncRequestIdRef.current;
      const [currentSession, currentTrace, sessions] = await Promise.all([
        client.getSessionSnapshot(sessionId),
        client.getSessionTrace(sessionId),
        client.listSessions(),
      ]);

      if (!active || requestId !== syncRequestIdRef.current) return;

      setSession(currentSession);
      setSessionTrace(currentTrace);
      setSavedSessions(sessions);
      setLiveDeviceState(currentSession.deviceState);
    }

    void syncCurrentSession();

    const unsubscribe = client.subscribe((event) => {
      setEvents((current) => [event, ...current].slice(0, 20));

      const isActiveSessionEvent = isActiveRuntimeSessionEvent(event, sessionId);

      if (isActiveSessionEvent && event.type === 'user-message-accepted') {
        setReplyBusy(true);
      }

      if (event.type === 'assistant-message-delta') {
        if (isActiveSessionEvent) {
          setReplyBusy(true);
          setStreamingAssistantText(event.content);
          onRuntimeEventRef.current?.(event);
        }
        return;
      }

      if (event.type === 'device-state-changed') {
        setLiveDeviceState(event.state);
      }

      if (event.type === 'device-command-executed') {
        setLiveDeviceState(event.result.state);
      }

      if (
        isActiveSessionEvent &&
        (event.type === 'assistant-message-completed' || event.type === 'assistant-message-aborted')
      ) {
        setReplyBusy(false);
      }

      if (isActiveSessionEvent && shouldClearStreamingForEvent(event)) {
        setStreamingAssistantText('');
      }

      if (
        event.type === 'assistant-message-completed' ||
        event.type === 'assistant-message-aborted'
      ) {
        setStreamingAssistantText('');
      }

      if (isActiveSessionEvent) {
        onRuntimeEventRef.current?.(event);
      }

      if (shouldRefreshSessionForEvent(event)) {
        if (isActiveSessionEvent) {
          void syncCurrentSession();
        } else {
          void refreshSavedSessions();
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeSessionId, client, enabled, refreshSavedSessions]);

  return {
    activeSessionId,
    setActiveSessionId,
    events,
    clearEvents,
    session,
    sessionTrace,
    setSession,
    savedSessions,
    setSavedSessions,
    liveDeviceState,
    replyBusy,
    streamingAssistantText,
    clearStreamingAssistantText,
    setStreamingAssistantText,
    refreshCurrentSession,
  };
}
