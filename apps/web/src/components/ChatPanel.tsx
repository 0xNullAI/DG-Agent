import { useEffect, useRef, useState } from 'react';
import type { DeviceState, SessionSnapshot } from '@dg-agent/core';
import {
  ArrowUp,
  AudioLines,
  Battery,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Bluetooth,
  Mic,
  CircleStop,
  PanelLeft,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText.js';
import type { TraceFeedItem } from '../utils/trace-feed.js';

interface ToolActivity {
  kind: 'proposed' | 'executed' | 'denied';
  text: string;
}

interface ChatPanelProps {
  activeSessionId: string | null;
  text: string;
  statusMessage: string | null;
  onTextChange: (value: string) => void;
  onAbortReply: () => void;
  onToggleVoiceMode: () => void;
  onSend: () => void;
  busy: boolean;
  voiceEnabled: boolean;
  voiceMode: boolean;
  voiceState: 'idle' | 'listening' | 'ready' | 'sending' | 'speaking';
  speechRecognitionSupported: boolean;
  session: SessionSnapshot | null;
  traceFeed: TraceFeedItem[];
  streamingAssistantText: string;
  deviceState: DeviceState;
  maxStrengthA: number;
  maxStrengthB: number;
  toolActivities: ToolActivity[];
  onConnect: () => void;
  onEmergencyStop: () => void;
  onOpenSidebar: () => void;
  onOpenSettings: () => void;
}

function BatteryIcon({ level }: { level: number | null | undefined }) {
  if (level == null) return <Battery className="h-3.5 w-3.5 text-[var(--text-faint)]" />;
  if (level <= 10) return <BatteryWarning className="h-3.5 w-3.5 text-[var(--danger)]" />;
  if (level <= 30) return <BatteryLow className="h-3.5 w-3.5 text-[var(--warning)]" />;
  if (level <= 70) return <BatteryMedium className="h-3.5 w-3.5 text-[var(--text-soft)]" />;
  return <BatteryFull className="h-3.5 w-3.5 text-[var(--success)]" />;
}

const MESSAGE_BATCH_SIZE = 120;
const DEVICE_STRENGTH_CAP = 200;

const BUBBLE_BASE = 'max-w-[min(92%,560px)] overflow-hidden break-words whitespace-pre-wrap px-4 py-3 text-[14.5px] leading-[1.6]';
const BUBBLE_ASSISTANT = `${BUBBLE_BASE} rounded-[14px] rounded-bl-[4px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-[var(--text)]`;
const BUBBLE_USER = `${BUBBLE_BASE} rounded-[14px] rounded-br-[4px] bg-[var(--accent)] text-[var(--button-text)]`;
const ICON_BTN = 'h-9 w-9 rounded-[10px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]';
const SYSTEM_MSG = 'max-w-[min(85%,480px)] rounded-[8px] border-l-[3px] border-l-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-1.5 text-[13px] leading-[1.35] text-[var(--text-soft)]';

function summarizeAssistantContent(content: string): string {
  const prefix = 'Fake LLM 已完成工具执行：';
  if (!content.startsWith(prefix)) {
    return content;
  }

  const jsonPart = content.slice(prefix.length).trim();
  try {
    const parsed = JSON.parse(jsonPart) as {
      command?: { type?: string; channel?: string; strength?: number; waveform?: { id?: string } };
    };

    const command = parsed.command;
    if (!command) {
      return '工具执行完成，设备状态已更新';
    }

    if (command.type === 'start') {
      return `已执行启动指令：${command.channel ?? '通道'} 通道，强度 ${command.strength ?? 0}，波形 ${command.waveform?.id ?? '默认'}`;
    }

    if (command.type === 'stop') {
      return `已执行停止指令：${command.channel ? `${command.channel} 通道` : '全部通道'}`;
    }

    return '工具执行完成，设备状态已更新';
  } catch {
    return '工具执行完成，设备状态已更新';
  }
}

function isToolExecutionSummary(content: string): boolean {
  return content.startsWith('Fake LLM 已完成工具执行：');
}

export function ChatPanel({
  activeSessionId,
  text,
  statusMessage,
  onTextChange,
  onAbortReply,
  onToggleVoiceMode,
  onSend,
  busy,
  voiceEnabled,
  voiceMode,
  voiceState: _voiceState,
  speechRecognitionSupported,
  session,
  traceFeed,
  streamingAssistantText,
  deviceState,
  maxStrengthA,
  maxStrengthB,
  toolActivities,
  onConnect,
  onEmergencyStop,
  onOpenSidebar,
  onOpenSettings,
}: ChatPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const hasText = text.trim().length > 0;
  const messages = session?.messages ?? [];
  const timelineItems = buildRenderableTimeline(messages, traceFeed);
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_BATCH_SIZE);
  const renderedMessages = timelineItems.slice(-visibleMessageCount);
  const voiceModeAvailable = voiceEnabled && speechRecognitionSupported;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamingAssistantText, busy, statusMessage]);

  useEffect(() => {
    setVisibleMessageCount(MESSAGE_BATCH_SIZE);
  }, [activeSessionId]);

  function handlePrimaryAction(): void {
    if (busy) {
      onAbortReply();
      return;
    }
    if (hasText) {
      onSend();
      return;
    }
    if (voiceModeAvailable) {
      onToggleVoiceMode();
    }
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy && hasText) onSend();
    }
  }

  const showVoiceAsPrimary = !hasText && !busy;

  return (
    <div className="relative flex w-full flex-1 flex-col overflow-hidden">
      {/* ===== Top bar — only visible on non-lg when device NOT connected ===== */}
      {!deviceState.connected && (
        <header className="flex shrink-0 items-center justify-between px-2 py-2 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BTN}
            onClick={onOpenSidebar}
            aria-label="历史记录"
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold text-[var(--text)]">DG-Agent</span>
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BTN}
            onClick={onOpenSettings}
            aria-label="设置"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </header>
      )}

      {/* ===== Device status bar — only when connected ===== */}
      {deviceState.connected && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1.5 sm:gap-2 sm:px-3 sm:py-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-[8px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)] lg:hidden"
            onClick={onOpenSidebar}
            aria-label="历史记录"
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-[8px] px-1.5 py-1 text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] sm:gap-1.5 sm:px-2"
            onClick={onConnect}
            title="重连设备"
          >
            <Bluetooth className="h-3.5 w-3.5 text-[var(--success)]" />
            <BatteryIcon level={deviceState.battery} />
            <span className="hidden text-[11px] tabular-nums sm:inline">
              {typeof deviceState.battery === 'number' ? `${deviceState.battery}%` : '--'}
            </span>
          </button>
          <ChannelStrengthBar channel="A" value={deviceState.strengthA} max={maxStrengthA} />
          <ChannelStrengthBar channel="B" value={deviceState.strengthB} max={maxStrengthB} />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-[8px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)] lg:hidden"
            onClick={onOpenSettings}
            aria-label="设置"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 shrink-0 rounded-[8px] px-2 text-[12px] font-medium shadow-none sm:px-2.5"
            onClick={onEmergencyStop}
            aria-label="紧急停止"
          >
            <CircleStop className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">停止</span>
          </Button>
        </div>
      )}

      {/* ===== Chat area ===== */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 [scrollbar-gutter:stable] sm:px-6">
        <div className="mx-auto flex min-h-full w-full max-w-[800px] flex-col justify-end gap-4 pb-4">
          {!busy && !streamingAssistantText && messages.length === 0 && (
            <div className="flex justify-start">
              <div className={BUBBLE_ASSISTANT}>
                欢迎使用DG-Agent，请使用蓝牙连接郊狼后开始使用哦！
              </div>
            </div>
          )}

          {timelineItems.length > renderedMessages.length && (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                className="rounded-full px-4 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                onClick={() => setVisibleMessageCount((current) => current + MESSAGE_BATCH_SIZE)}
              >
                加载更早消息（还有 {timelineItems.length - renderedMessages.length} 条）
              </Button>
            </div>
          )}

          {renderedMessages.map((message) => {
            if (message.kind === 'trace-system') {
              return (
                <div key={message.id} className="flex justify-center">
                  <div className={SYSTEM_MSG}>{message.content}</div>
                </div>
              );
            }

            if (message.role === 'assistant' && isToolExecutionSummary(message.content)) {
              return (
                <div key={message.id} className="flex justify-center">
                  <div className="max-w-[min(85%,480px)] rounded-[8px] border border-[var(--surface-border)] bg-[var(--bg-soft)] px-4 py-2 text-sm text-[var(--text-soft)]">
                    {summarizeAssistantContent(message.content)}
                  </div>
                </div>
              );
            }

            if (message.role === 'system') {
              return (
                <div key={message.id} className="flex justify-center">
                  <div className={SYSTEM_MSG}>{message.content}</div>
                </div>
              );
            }

            const userMessage = message.role === 'user';
            return (
              <div
                key={message.id}
                className={cn('flex', userMessage ? 'justify-end' : 'justify-start')}
              >
                <div className={userMessage ? BUBBLE_USER : BUBBLE_ASSISTANT}>
                  {userMessage ? message.content : <MarkdownText content={message.content} />}
                </div>
              </div>
            );
          })}

          {toolActivities.length > 0 && (
            <div className="flex flex-col items-center gap-1">
              {toolActivities.map((activity, index) => (
                <div
                  key={index}
                  className={cn(
                    'inline-flex max-w-[85%] items-center gap-1.5 rounded-full px-3 py-1 text-[12px] leading-[1.4]',
                    activity.kind === 'executed'
                      ? 'bg-[var(--success-soft)] text-[var(--success)]'
                      : activity.kind === 'denied'
                        ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                        : 'bg-[var(--bg-soft)] text-[var(--text-soft)]',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                      activity.kind === 'executed'
                        ? 'bg-[var(--success)]'
                        : activity.kind === 'denied'
                          ? 'bg-[var(--danger)]'
                          : 'bg-[var(--text-faint)]',
                    )}
                  />
                  {activity.text}
                </div>
              ))}
            </div>
          )}

          {streamingAssistantText && (
            <div className="flex justify-start">
              <div className={BUBBLE_ASSISTANT}>
                <MarkdownText content={streamingAssistantText} />
              </div>
            </div>
          )}

          {busy && !streamingAssistantText && (
            <div className="flex justify-start">
              <div className="inline-flex items-center gap-1 rounded-[14px] rounded-bl-[4px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
                <span className="h-2 w-2 rounded-full bg-[var(--text-faint)] animate-pulse" />
                <span className="h-2 w-2 rounded-full bg-[var(--text-faint)] animate-pulse [animation-delay:120ms]" />
                <span className="h-2 w-2 rounded-full bg-[var(--text-faint)] animate-pulse [animation-delay:240ms]" />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* ===== Input area ===== */}
      <div className="mx-auto flex w-full max-w-[800px] shrink-0 items-center gap-2 px-3 pb-1 sm:px-6">
        <Input
          ref={inputRef}
          type="text"
          value={text}
          disabled={busy || voiceMode || !deviceState.connected}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={!deviceState.connected ? '请连接蓝牙' : voiceMode ? '语音识别中…' : '输入消息…'}
          className="!h-10 flex-1 rounded-full"
        />
        {!deviceState.connected ? (
          <Button
            variant="default"
            size="icon"
            className="h-10 w-10 shrink-0 rounded-[10px]"
            onClick={onConnect}
            aria-label="连接蓝牙"
          >
            <Bluetooth className="h-4 w-4" />
          </Button>
        ) : voiceMode ? (
          <Button
            variant="destructive"
            size="icon"
            className="h-10 w-10 shrink-0 rounded-[10px]"
            onClick={onToggleVoiceMode}
            aria-label="结束识别"
          >
            <Mic className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant={busy ? 'destructive' : showVoiceAsPrimary && voiceModeAvailable ? 'secondary' : hasText ? 'default' : 'ghost'}
            size="icon"
            className="h-10 w-10 shrink-0 rounded-[10px]"
            disabled={!activeSessionId || (!hasText && !busy && !voiceModeAvailable)}
            onClick={handlePrimaryAction}
            aria-label={busy ? '停止回复' : hasText ? '发送' : voiceModeAvailable ? '语音识别' : '发送'}
          >
            {showVoiceAsPrimary && voiceModeAvailable ? (
              <AudioLines className="h-4 w-4" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
      <p className="shrink-0 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 text-center text-[11px] text-[var(--text-faint)]">
        本项目仅供学习交流使用，请遵守当地法律法规。{' '}
        <a
          href="https://github.com/0xNullAI/DG-Agent"
          target="_blank"
          rel="noopener noreferrer"
          className="underline transition-colors hover:text-[var(--text-soft)]"
        >
          GitHub
        </a>
      </p>
    </div>
  );
}

interface ChannelStrengthBarProps {
  channel: 'A' | 'B';
  value: number;
  max: number;
}

function ChannelStrengthBar({ channel, value, max }: ChannelStrengthBarProps) {
  const normalizedValue = clampPercentage((value / DEVICE_STRENGTH_CAP) * 100);
  const normalizedMax = clampPercentage((max / DEVICE_STRENGTH_CAP) * 100);

  return (
    <div className="grid flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 sm:gap-1.5">
      <span className="text-[10px] font-semibold leading-none tracking-wide text-[var(--accent)]">
        {channel}
      </span>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-[var(--bg-soft)] sm:h-3.5">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]/80 transition-[width] duration-300 ease-out"
          style={{ width: `${normalizedValue}%` }}
        />
        <div
          className="absolute inset-y-[-2px] w-[3px] rounded-full bg-[var(--danger)]/85"
          style={{ left: `calc(${normalizedMax}% - 1.5px)` }}
        />
      </div>
      <span className="text-[10px] font-medium tabular-nums leading-none text-[var(--text-soft)]">
        {value}
      </span>
    </div>
  );
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

type TimelineItem =
  | (SessionSnapshot['messages'][number] & { kind: 'message' })
  | { kind: 'trace-system'; id: string; content: string; createdAt: number };

function buildRenderableTimeline(
  messages: SessionSnapshot['messages'],
  traceFeed: TraceFeedItem[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((message) => ({
      ...message,
      kind: 'message' as const,
    })),
    ...traceFeed.map((item) => ({
      kind: 'trace-system' as const,
      id: `trace-feed:${item.id}`,
      content: item.text,
      createdAt: item.createdAt,
    })),
  ];

  return items.sort((left, right) => left.createdAt - right.createdAt);
}
