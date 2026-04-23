import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSnapshot } from '@dg-agent/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTimestamp, getSessionTitle } from '../utils/ui-formatters.js';

interface SessionSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSnapshot[];
  onSelectSession: (sessionId: string) => void;
}

export function SessionSearchDialog({
  open,
  onOpenChange,
  sessions,
  onSelectSession,
}: SessionSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return sessions.filter((session) => {
      const title = getSessionTitle(session).toLowerCase();
      if (title.includes(trimmed)) return true;
      return session.messages.some(
        (msg) => typeof msg.content === 'string' && msg.content.toLowerCase().includes(trimmed),
      );
    });
  }, [sessions, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [results.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      onSelectSession(results[activeIndex].id);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm animate-in fade-in-0 duration-150" />
        <DialogPrimitive.Content
          className="fixed inset-x-4 top-[max(env(safe-area-inset-top),10vh)] z-50 mx-auto max-w-[540px] overflow-hidden rounded-[16px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)] animate-in fade-in-0 slide-in-from-top-2 duration-200"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onKeyDown={handleKeyDown}
        >
          <DialogPrimitive.Title className="sr-only">搜索历史对话</DialogPrimitive.Title>

          {/* Search bar */}
          <div className="flex items-center gap-3 px-4 py-3">
            <Search className="h-[18px] w-[18px] shrink-0 text-[var(--text-faint)]" />
            <input
              ref={inputRef}
              type="text"
              placeholder="搜索历史对话..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
            />
            <kbd className="hidden shrink-0 rounded-[6px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-1.5 py-0.5 text-[11px] text-[var(--text-faint)] sm:inline-block">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[min(50vh,400px)] overflow-y-auto border-t border-[var(--surface-border)]">
            {query.trim() && results.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-[var(--text-faint)]">
                <Search className="h-8 w-8 opacity-30" />
                <span className="text-sm">没有匹配的对话</span>
              </div>
            )}
            {!query.trim() && (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-[var(--text-faint)]">
                <span className="text-sm">输入关键词搜索历史对话</span>
              </div>
            )}
            {results.length > 0 && (
              <div className="p-1.5">
                {results.map((session, index) => (
                  <button
                    key={session.id}
                    type="button"
                    className={cn(
                      'w-full rounded-[10px] px-3.5 py-2.5 text-left transition-colors',
                      index === activeIndex
                        ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                        : 'text-[var(--text)] hover:bg-[var(--bg-soft)]',
                    )}
                    onClick={() => onSelectSession(session.id)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <div className="truncate text-[13px] font-medium">
                      {getSessionTitle(session)}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">
                      {formatTimestamp(session.updatedAt)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
