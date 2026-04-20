import { useEffect, useState } from 'react';
import type { RuntimeEvent } from '@dg-agent/core';

interface ToastItem {
  key: string;
  text: string;
  variant: 'destructive' | 'warning' | 'info';
}

interface UseToastManagerOptions {
  errorMessage: string | null;
  warnings: string[];
  events: RuntimeEvent[];
}

interface UseToastManagerResult {
  visibleErrorItems: ToastItem[];
  visibleWarnings: ToastItem[];
  visibleEventToasts: ToastItem[];
  hasVisibleToasts: boolean;
}

export function useToastManager({
  errorMessage,
  warnings,
  events,
}: UseToastManagerOptions): UseToastManagerResult {
  const [toastVisibility, setToastVisibility] = useState<Record<string, boolean>>({});

  const errorToastItems: ToastItem[] = errorMessage
    ? [{ key: `error:${errorMessage}`, text: errorMessage, variant: 'destructive' }]
    : [];

  const warningToastItems: ToastItem[] = warnings.map((warning) => ({
    key: `warning:${warning}`,
    text: warning,
    variant: 'warning',
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
          };
      }
    });

  const autoDismissToastItems = [...errorToastItems, ...warningToastItems, ...eventToastItems];
  const autoDismissToastKey = autoDismissToastItems.map((item) => item.key).join('||');

  useEffect(() => {
    setToastVisibility((current) =>
      Object.fromEntries(
        autoDismissToastItems.map((item) => [item.key, current[item.key] ?? true]),
      ),
    );

    const timers = autoDismissToastItems.map((item) =>
      window.setTimeout(() => {
        setToastVisibility((current) =>
          current[item.key] === false ? current : { ...current, [item.key]: false },
        );
      }, 4200),
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [autoDismissToastKey]);

  const visibleErrorItems = errorToastItems.filter((item) => toastVisibility[item.key] !== false);
  const visibleWarnings = warningToastItems.filter((item) => toastVisibility[item.key] !== false);
  const visibleEventToasts = eventToastItems.filter((item) => toastVisibility[item.key] !== false);

  return {
    visibleErrorItems,
    visibleWarnings,
    visibleEventToasts,
    hasVisibleToasts:
      visibleErrorItems.length > 0 || visibleWarnings.length > 0 || visibleEventToasts.length > 0,
  };
}
