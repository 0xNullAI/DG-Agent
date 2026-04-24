import { useEffect, useState } from 'react';
import type { RuntimeEvent } from '@dg-agent/core';

const TOAST_AUTO_DISMISS_MS = 4200;
const TOAST_EXIT_DURATION_MS = 220;

interface ToastItem {
  key: string;
  text: string;
  variant: 'destructive' | 'warning' | 'info';
  kind: 'error' | 'warning' | 'event';
}

interface RenderToastItem extends ToastItem {
  phase: 'entering' | 'visible' | 'exiting';
}

interface UseToastManagerOptions {
  errorMessage: string | null;
  warnings: string[];
  events: RuntimeEvent[];
}

interface UseToastManagerResult {
  visibleErrorItems: RenderToastItem[];
  visibleWarnings: RenderToastItem[];
  visibleEventToasts: RenderToastItem[];
  hasVisibleToasts: boolean;
}

export function useToastManager({
  errorMessage,
  warnings,
  events,
}: UseToastManagerOptions): UseToastManagerResult {
  const [toastVisibility, setToastVisibility] = useState<Record<string, boolean>>({});
  const [renderedToasts, setRenderedToasts] = useState<Record<string, RenderToastItem>>({});

  const errorToastItems: ToastItem[] = errorMessage
    ? [
        {
          key: `error:${errorMessage}`,
          text: errorMessage,
          variant: 'destructive',
          kind: 'error',
        },
      ]
    : [];

  const warningToastItems: ToastItem[] = warnings.map((warning) => ({
    key: `warning:${warning}`,
    text: warning,
    variant: 'warning',
    kind: 'warning',
  }));

  const eventToastItems: ToastItem[] = events
    .filter((event) => event.type === 'assistant-message-aborted')
    .slice(0, 4)
    .map((event) => {
      switch (event.type) {
        case 'assistant-message-aborted':
          return {
            key: `event:aborted:${event.sessionId}:${event.message.id}`,
            text: '已停止当前回复',
            variant: 'info' as const,
            kind: 'event' as const,
          };
      }
    });

  const sourceToastItems = [...errorToastItems, ...warningToastItems, ...eventToastItems];
  const sourceToastKey = sourceToastItems.map((item) => item.key).join('||');
  const activeToastItems = sourceToastItems.filter((item) => toastVisibility[item.key] !== false);
  const activeToastKey = activeToastItems.map((item) => item.key).join('||');

  useEffect(() => {
    setToastVisibility((current) =>
      Object.fromEntries(sourceToastItems.map((item) => [item.key, current[item.key] ?? true])),
    );
  }, [sourceToastKey]);

  useEffect(() => {
    const timers = sourceToastItems.map((item) =>
      window.setTimeout(() => {
        setToastVisibility((current) =>
          current[item.key] === false ? current : { ...current, [item.key]: false },
        );
      }, TOAST_AUTO_DISMISS_MS),
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [sourceToastKey]);

  useEffect(() => {
    setRenderedToasts((current) => {
      const activeKeys = new Set(activeToastItems.map((item) => item.key));
      const next: Record<string, RenderToastItem> = {};

      for (const item of activeToastItems) {
        const existing = current[item.key];
        next[item.key] = {
          ...item,
          phase: existing?.phase === 'visible' ? 'visible' : 'entering',
        };
      }

      for (const [key, item] of Object.entries(current)) {
        if (activeKeys.has(key)) continue;
        next[key] = item.phase === 'exiting' ? item : { ...item, phase: 'exiting' };
      }

      return next;
    });
  }, [activeToastKey]);

  const enteringToastKey = Object.values(renderedToasts)
    .filter((item) => item.phase === 'entering')
    .map((item) => item.key)
    .join('||');

  useEffect(() => {
    if (!enteringToastKey) return;

    const timer = window.setTimeout(() => {
      setRenderedToasts((current) => {
        let changed = false;
        const next = { ...current };

        for (const [key, item] of Object.entries(next)) {
          if (item.phase !== 'entering') continue;
          next[key] = { ...item, phase: 'visible' };
          changed = true;
        }

        return changed ? next : current;
      });
    }, 16);

    return () => {
      window.clearTimeout(timer);
    };
  }, [enteringToastKey]);

  const exitingToastKey = Object.values(renderedToasts)
    .filter((item) => item.phase === 'exiting')
    .map((item) => item.key)
    .join('||');

  useEffect(() => {
    if (!exitingToastKey) return;

    const timers = Object.values(renderedToasts)
      .filter((item) => item.phase === 'exiting')
      .map((item) =>
        window.setTimeout(() => {
          setRenderedToasts((current) => {
            const currentItem = current[item.key];
            if (!currentItem || currentItem.phase !== 'exiting') {
              return current;
            }

            const next = { ...current };
            delete next[item.key];
            return next;
          });
        }, TOAST_EXIT_DURATION_MS),
      );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [exitingToastKey, renderedToasts]);

  const renderedToastItems = Object.values(renderedToasts);
  const visibleErrorItems = renderedToastItems.filter((item) => item.kind === 'error');
  const visibleWarnings = renderedToastItems.filter((item) => item.kind === 'warning');
  const visibleEventToasts = renderedToastItems.filter((item) => item.kind === 'event');

  return {
    visibleErrorItems,
    visibleWarnings,
    visibleEventToasts,
    hasVisibleToasts: renderedToastItems.length > 0,
  };
}
