import { useEffect, useState } from 'react';
import type { SessionSnapshot } from '@dg-agent/core';
import { MessageSquarePlus, PanelLeft, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { formatTimestamp, getSessionTitle } from '../utils/ui-formatters.js';

interface SessionPanelProps {
  savedSessions: SessionSnapshot[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onCreateSession?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

const SESSION_BATCH_SIZE = 80;

export function SessionPanel({
  savedSessions,
  activeSessionId,
  onSelectSession,
  onDeleteSession,
  onCreateSession,
  collapsed = false,
  onToggleCollapsed,
}: SessionPanelProps) {
  const visibleSessions = savedSessions.filter((session) => session.messages.some((message) => message.role === 'user'));
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_BATCH_SIZE);
  const renderedSessions = visibleSessions.slice(0, visibleSessionCount);

  useEffect(() => {
    setVisibleSessionCount(SESSION_BATCH_SIZE);
  }, [activeSessionId, visibleSessions.length]);

  if (collapsed) {
    return (
      <Card className="flex h-full min-h-0 flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none transition-all duration-300 ease-out">
        <div className="shrink-0 px-2 py-2"> 
          {
            onToggleCollapsed && (
              <Button
                variant="ghost"
                className="h-10 w-full justify-start rounded-[12px] pl-4 pr-0 py-2.5 text-[13px] font-medium tracking-[-0.01em] text-[var(--text-soft)] shadow-none transition-all duration-300 ease-out hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                onClick={onToggleCollapsed}
                aria-label="展开侧边栏"
              >
                <PanelLeft className="h-4 w-4 transition-transform duration-300 ease-out" />
              </Button>)
          }
          {onCreateSession && (
            <Button
              variant="ghost"
              className="mt-4 h-10 w-12 justify-start rounded-[12px] pl-4 pr-0 py-2.5 text-[13px] font-medium tracking-[-0.01em] text-[var(--text-soft)] shadow-none transition-all duration-300 ease-out hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
              onClick={onCreateSession}
              aria-label="发起新对话"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="flex h-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none transition-all duration-300 ease-out">
      <CardHeader className="shrink-0 px-2.5 pb-3 pt-0">
        <div className="transition-all duration-300 ease-out">
          {onToggleCollapsed && (
            <div className="relative flex items-center py-2">
              <div className="w-full">
                <Button
                  variant="ghost"
                  className="h-10 w-full justify-start gap-3 rounded-[12px] pl-4 pr-2 text-[13px] font-medium tracking-[-0.01em] text-[var(--text-soft)] shadow-none transition-all duration-300 ease-out hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                  onClick={onToggleCollapsed}
                  aria-label="收起侧边栏"
                >
                  <PanelLeft className="h-4 w-4 transition-transform duration-300 ease-out -ml-0.5" />
                  <span className="transition-opacity duration-200 ease-out -mt-[0.15em]">收起</span>
                </Button>
              </div>
              <div className="absolute inset-x-1 bottom-[1.5px] border-t border-[var(--surface-border)] opacity-100" />
            </div>
          )}

          <div className="flex items-center justify-between gap-3 px-2 mt-4">
            <div className="pl-1 text-xs font-medium uppercase tracking-[0.14em] text-[var(--text-faint)]">历史记录</div>
            {onCreateSession && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                onClick={onCreateSession}
              >
                <MessageSquarePlus className="h-3.5 w-3.5 mr-1" />
                <span className="-mt-[0.15em] text-[14px]">新对话</span>
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 overflow-hidden px-2.5 py-1">
        <ScrollArea className="h-full min-h-0 max-h-full pr-1">
          <div className="space-y-1">
            {visibleSessions.length === 0 && (
              <div className="px-2 py-4 text-sm text-[var(--text-soft)]">
                <div className="pl-3">还没有保存的会话</div>
              </div>
            )}

            {renderedSessions.map((item) => {
              const active = item.id === activeSessionId;
              return (
                <div
                  key={item.id}
                  className={cn(
                    'group grid grid-cols-[minmax(0,1fr)_28px] items-start gap-1 rounded-[12px] px-2 py-2 transition-colors',
                    active ? 'bg-[var(--bg-soft)]' : 'hover:bg-[var(--bg-soft)]',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 bg-transparent px-0 py-0 text-left text-inherit"
                    onClick={() => onSelectSession(item.id)}
                  >
                    <div className="min-w-0 pl-3 pr-2">
                      <div className={cn('truncate text-[13px] leading-5', active ? 'font-medium text-[var(--text)]' : 'font-normal text-[var(--text)]')}>
                        {getSessionTitle(item)}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--text-faint)]">{formatTimestamp(item.updatedAt)}</div>
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-7 w-7 self-center rounded-full text-[var(--text-faint)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]',
                      active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                    )}
                    onClick={() => onDeleteSession(item.id)}
                    aria-label="删除会话"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}

            {visibleSessions.length > renderedSessions.length && (
              <div className="px-2 py-2">
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start rounded-[12px] px-3 py-2 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                  onClick={() => setVisibleSessionCount((current) => current + SESSION_BATCH_SIZE)}
                >
                  显示更多历史（剩余 {visibleSessions.length - renderedSessions.length} 条）
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

    </Card>
  );
}
