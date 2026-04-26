import { useCallback, useEffect, useState } from 'react';
import type { RuntimeEvent } from '@dg-agent/core';
import {
  appendModelLogEvent,
  clearModelLogs,
  loadModelLogs,
  type ModelLogTurn,
} from '../services/model-log-store.js';

export interface UseModelLogResult {
  turns: ModelLogTurn[];
  ingest: (event: RuntimeEvent) => void;
  clear: () => void;
}

export function useModelLog(enabled: boolean): UseModelLogResult {
  const [turns, setTurns] = useState<ModelLogTurn[]>(loadModelLogs);

  useEffect(() => {
    if (enabled) return;
    // When disabled, existing entries stay in state and storage; ingest just no-ops.
  }, [enabled]);

  const ingest = useCallback(
    (event: RuntimeEvent) => {
      if (!enabled) return;
      if (event.type !== 'llm-turn-start' && event.type !== 'llm-turn-complete') return;
      setTurns((current) => appendModelLogEvent(current, event));
    },
    [enabled],
  );

  const clear = useCallback(() => {
    clearModelLogs();
    setTurns([]);
  }, []);

  return { turns, ingest, clear };
}
