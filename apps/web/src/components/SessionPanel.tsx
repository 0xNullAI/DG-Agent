import { useEffect, useState } from 'react';
import type { SessionSnapshot } from '@dg-agent/core';
import { PanelLeftClose, PanelLeftOpen, Search, Settings, SquarePen, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { formatTimestamp, getSessionTitle } from '../utils/ui-formatters.js';
import { SessionSearchDialog } from './SessionSearchDialog.js';

interface SessionPanelProps {
  savedSessions: SessionSnapshot[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onCreateSession?: () => void;
  onOpenSettings?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  detached?: boolean;
}

const SESSION_BATCH_SIZE = 60;
const ICON_BTN =
  'h-9 w-9 rounded-[10px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]';
const SIDEBAR_BTN =
  'h-9 w-full justify-start gap-2.5 rounded-[10px] px-3 text-[13px] font-medium text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]';

export function SessionPanel({
  savedSessions,
  activeSessionId,
  onSelectSession,
  onDeleteSession,
  onCreateSession,
  onOpenSettings,
  collapsed = false,
  onToggleCollapsed,
  detached = false,
}: SessionPanelProps) {
  const visibleSessions = savedSessions.filter((session) =>
    session.messages.some((message) => message.role === 'user'),
  );
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_BATCH_SIZE);
  const renderedSessions = visibleSessions.slice(0, visibleSessionCount);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    setVisibleSessionCount(SESSION_BATCH_SIZE);
  }, [activeSessionId, visibleSessions.length]);

  /* ===== Collapsed ===== */
  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 py-4">
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BTN}
            onClick={onToggleCollapsed}
            aria-label="展开侧边栏"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        )}
        <div className="w-5 border-t border-[var(--surface-border)]" />
        {onCreateSession && (
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BTN}
            onClick={onCreateSession}
            aria-label="发起新对话"
          >
            <SquarePen className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={ICON_BTN}
          onClick={() => setSearchOpen(true)}
          aria-label="搜索对话"
        >
          <Search className="h-4 w-4" />
        </Button>
        <div className="flex-1" />
        {onOpenSettings && (
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BTN}
            onClick={onOpenSettings}
            aria-label="设置"
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}
        <SessionSearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          sessions={visibleSessions}
          onSelectSession={(id) => {
            setSearchOpen(false);
            onSelectSession(id);
          }}
        />
      </div>
    );
  }

  /* ===== Expanded ===== */
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header: title + collapse */}
      {!detached && (
        <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-2">
          <h1 className="text-[16px] font-bold tracking-tight text-[var(--text)]">DG-Agent</h1>
          {onToggleCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-[10px] text-[var(--text-faint)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
              onClick={onToggleCollapsed}
              aria-label="收起侧边栏"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {/* Action buttons — each on its own row */}
      <div className="shrink-0 space-y-0.5 px-3 pb-3 mt-1">
        {onCreateSession && (
          <Button variant="ghost" className={SIDEBAR_BTN} onClick={onCreateSession}>
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="text-sm -mt-[0.1em] ml-1">新对话</span>
          </Button>
        )}
        <Button variant="ghost" className={SIDEBAR_BTN} onClick={() => setSearchOpen(true)}>
          <Search className="h-4 w-4 shrink-0" />
          <span className="text-sm -mt-[0.1em] ml-1">搜索</span>
        </Button>
      </div>

      {/* Divider */}
      <div className="mx-4 border-t border-[var(--surface-border)]" />

      {/* Session list */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-2">
        <ScrollArea className="h-full px-3">
          <div className="space-y-0.5 pb-4">
            {visibleSessions.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-[var(--text-faint)]">
                还没有保存的会话
              </div>
            )}
            {renderedSessions.map((item) => {
              const active = item.id === activeSessionId;
              return (
                <div
                  key={item.id}
                  className={cn(
                    'group relative flex items-center gap-1 rounded-[10px] transition-colors',
                    active ? 'bg-[var(--bg-soft)]' : 'hover:bg-[var(--bg-soft)]',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-left"
                    onClick={() => onSelectSession(item.id)}
                  >
                    <div
                      className={cn(
                        'truncate text-[13px] leading-5',
                        active ? 'font-medium text-[var(--text)]' : 'text-[var(--text)]',
                      )}
                    >
                      {getSessionTitle(item)}
                    </div>
                    <div className="text-[11px] text-[var(--text-faint)]">
                      {formatTimestamp(item.updatedAt)}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'mr-1 h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] transition-all hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]',
                      active
                        ? 'opacity-60 hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100',
                    )}
                    onClick={() => onDeleteSession(item.id)}
                    aria-label="删除会话"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
            {visibleSessions.length > renderedSessions.length && (
              <div className="pt-2 text-center">
                <Button
                  variant="ghost"
                  className="h-8 rounded-full px-4 text-xs text-[var(--text-faint)] hover:text-[var(--text)]"
                  onClick={() => setVisibleSessionCount((current) => current + SESSION_BATCH_SIZE)}
                >
                  加载更多（{visibleSessions.length - renderedSessions.length}）
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Settings — bottom */}
      {onOpenSettings && (
        <div className="shrink-0 border-t border-[var(--surface-border)] px-3 py-2">
          <Button variant="ghost" className={SIDEBAR_BTN} onClick={onOpenSettings}>
            <Settings className="h-4 w-4 shrink-0" />
            <span className="text-sm -mt-[0.1em] ml-1">设置</span>
          </Button>
        </div>
      )}

      <SessionSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        sessions={visibleSessions}
        onSelectSession={(id) => {
          setSearchOpen(false);
          onSelectSession(id);
        }}
      />
    </div>
  );
}
