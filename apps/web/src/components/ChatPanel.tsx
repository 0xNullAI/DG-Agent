import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from 'react';
import type { DeviceState, SessionSnapshot } from '@dg-agent/core';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
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
  OctagonX,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText.js';
import { PresetSelector } from './PresetSelector.js';
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
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
  onSaveCurrentPromptPreset: () => void;
  onDeleteSavedPromptPreset: (presetId: string) => void;
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
  voiceState,
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
  settingsDraft,
  setSettingsDraft,
  onSaveCurrentPromptPreset,
  onDeleteSavedPromptPreset,
}: ChatPanelProps) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const _listening = voiceState === 'listening';
  const hasText = text.trim().length > 0;
  const messages = session?.messages ?? [];
  const timelineItems = buildRenderableTimeline(messages, traceFeed);
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_BATCH_SIZE);
  const renderedMessages = timelineItems.slice(-visibleMessageCount);
  const voiceModeAvailable = voiceEnabled && speechRecognitionSupported;
  const emergencyStopDisabled = !activeSessionId || !deviceState.connected;

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }, [text]);

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

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (!busy && hasText) {
      onSend();
    }
  }

  const showVoiceAsPrimary = !hasText && !busy;

  return (
    <div className="relative flex min-h-full w-full flex-1 flex-col overflow-hidden">
      {/* ===== Top bar ===== */}
      <header className="relative z-20 flex shrink-0 items-center justify-between gap-1 bg-[var(--glass)] px-2 backdrop-blur-xl sm:gap-2 sm:px-3 py-2">
        {/* Left */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-[10px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)] lg:hidden"
            onClick={onOpenSidebar}
            aria-label="历史记录"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
              <path d="M14 10h3" />
              <path d="M14 14h3" />
            </svg>
          </Button>
          <h1 className="text-[17px] font-bold tracking-[-0.3px] text-[var(--text)]">DG-Agent</h1>
          <span
            className={cn(
              'inline-block h-2 w-2 rounded-full transition-colors',
              deviceState.connected ? 'bg-[var(--success)]' : 'bg-[var(--text-faint)]',
            )}
          />
        </div>

        {/* Center — preset selector */}
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <PresetSelector
            settingsDraft={settingsDraft}
            setSettingsDraft={setSettingsDraft}
            onSaveCurrentPromptPreset={onSaveCurrentPromptPreset}
            onDeleteSavedPromptPreset={onDeleteSavedPromptPreset}
          />
        </div>

        {/* Right */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="destructive"
            size="sm"
            className="h-9 w-9 rounded-[10px] px-0 text-[13px] font-medium shadow-none sm:w-auto sm:gap-1.5 sm:px-3"
            disabled={emergencyStopDisabled}
            onClick={onEmergencyStop}
            aria-label="紧急停止"
          >
            <OctagonX className="h-4 w-4" />
            <span className="hidden sm:inline">停止</span>
          </Button>

          {/* Connect — animates away when connected */}
          <div
            className={cn(
              'overflow-hidden transition-all duration-300 ease-out',
              deviceState.connected ? 'w-0 opacity-0' : 'w-auto opacity-100',
            )}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-[10px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
              disabled={!activeSessionId}
              onClick={onConnect}
              aria-label="连接设备"
            >
              <Bluetooth className="h-5 w-5" />
            </Button>
          </div>

          {/* Device info — appears when connected */}
          {deviceState.connected && (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
              onClick={onConnect}
              title="重连设备"
            >
              <Bluetooth className="h-3.5 w-3.5 text-[var(--success)]" />
              <BatteryIcon level={deviceState.battery} />
              <span className="text-[11px] tabular-nums">
                {typeof deviceState.battery === 'number' ? `${deviceState.battery}%` : '--'}
              </span>
            </button>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-[10px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            onClick={onOpenSettings}
            aria-label="设置"
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <div className="border-t border-[var(--surface-border)]" />

      {/* ===== Device strength bar — only when connected ===== */}
      {deviceState.connected && (
        <div className="flex shrink-0 items-center gap-4 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-2 animate-in slide-in-from-top-1 duration-200">
          <ChannelStrengthBar channel="A" value={deviceState.strengthA} max={maxStrengthA} />
          <ChannelStrengthBar channel="B" value={deviceState.strengthB} max={maxStrengthB} />
        </div>
      )}

      {/* ===== Chat area ===== */}
      <div className="main-content-scroll min-h-0 flex-1 overflow-y-auto px-4 pt-3 [scrollbar-gutter:stable] sm:px-6">
        <div className="mx-auto flex min-h-full w-full max-w-[800px] flex-col justify-end gap-4 pb-3">
          {!busy && !streamingAssistantText && messages.length === 0 && (
            <div className="flex justify-start">
              <div className="max-w-[92%] overflow-hidden break-words whitespace-pre-wrap rounded-[14px] rounded-bl-[4px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3 text-[14.5px] leading-[1.6] text-[var(--text)]">
                你好！我是 DG-Agent，可以帮你通过自然语言控制 DG-Lab Coyote 设备。{'\n\n'}
                请先点击右上角蓝牙按钮连接设备，然后告诉我你想做什么。
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
                  <div className="max-w-[85%] rounded-[8px] border-l-[3px] border-l-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-1 text-[13px] leading-[1.35] text-[var(--text-soft)]">
                    {message.content}
                  </div>
                </div>
              );
            }

            if (message.role === 'assistant' && isToolExecutionSummary(message.content)) {
              return (
                <div key={message.id} className="flex justify-center">
                  <div className="max-w-[85%] rounded-[8px] border border-[var(--surface-border)] bg-[var(--bg-soft)] px-4 py-2 text-sm text-[var(--text-soft)]">
                    {summarizeAssistantContent(message.content)}
                  </div>
                </div>
              );
            }

            if (message.role === 'system') {
              return (
                <div key={message.id} className="flex justify-center">
                  <div className="max-w-[85%] rounded-[8px] border-l-[3px] border-l-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-1.5 text-[13px] leading-[1.35] text-[var(--text-soft)]">
                    {message.content}
                  </div>
                </div>
              );
            }

            const userMessage = message.role === 'user';
            return (
              <div
                key={message.id}
                className={cn('flex', userMessage ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[92%] overflow-hidden break-words whitespace-pre-wrap px-4 py-3 text-[14.5px] leading-[1.6]',
                    userMessage
                      ? 'rounded-[14px] rounded-br-[4px] bg-[var(--accent)] text-[var(--button-text)]'
                      : 'rounded-[14px] rounded-bl-[4px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-[var(--text)]',
                  )}
                >
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
              <div className="max-w-[92%] overflow-hidden break-words whitespace-pre-wrap rounded-[14px] rounded-bl-[4px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3 text-[14.5px] leading-[1.6] text-[var(--text)]">
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

      {/* ===== Input area — single row ===== */}
      <div className="z-30 shrink-0 border-t border-[var(--surface-border)] bg-[var(--glass)] px-4 pb-[env(safe-area-inset-bottom,8px)] pt-2 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex w-full max-w-[800px] items-end gap-2">
          <Textarea
            ref={composerRef}
            value={text}
            disabled={busy || voiceMode}
            rows={1}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={voiceMode ? '语音识别中…' : '输入消息…'}
            className="box-border min-h-[40px] max-h-[140px] flex-1 resize-none overflow-y-hidden rounded-[20px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-[9px] text-[15px] leading-[1.4] shadow-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
          />
          {voiceMode ? (
            <Button
              variant="destructive"
              size="icon"
              className="h-[40px] w-[40px] shrink-0 rounded-full"
              onClick={onToggleVoiceMode}
              aria-label="结束识别"
            >
              <Mic className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant={busy ? 'destructive' : showVoiceAsPrimary ? 'secondary' : 'default'}
              size="icon"
              className="h-[40px] w-[40px] shrink-0 rounded-full"
              disabled={!activeSessionId || (showVoiceAsPrimary && !voiceModeAvailable)}
              onClick={handlePrimaryAction}
              aria-label={busy ? '停止回复' : hasText ? '发送' : '语音识别'}
            >
              {showVoiceAsPrimary ? (
                <AudioLines className="h-4 w-4" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
        <div className="h-2" />
      </div>
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
    <div className="grid flex-1 grid-cols-[16px_minmax(0,1fr)_26px] items-center gap-2">
      <span className="justify-self-start text-[10px] font-semibold leading-none tracking-[0.12em] text-[var(--accent)]">
        {channel}
      </span>
      <div className="relative h-2.5 w-full justify-self-stretch overflow-hidden rounded-full bg-[var(--bg-soft)]">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]/80 transition-[width] duration-300 ease-out"
          style={{ width: `${normalizedValue}%` }}
        />
        <div
          className="absolute inset-y-[-2px] w-[3px] rounded-full bg-[var(--danger)]/85"
          style={{ left: `calc(${normalizedMax}% - 1.5px)` }}
        />
      </div>
      <span className="justify-self-end text-right text-[10px] font-medium tabular-nums leading-none text-[var(--text-soft)]">
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
