import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DeviceState, SessionSnapshot } from '@dg-agent/core';
import { ArrowUp, Bluetooth, Mic, OctagonX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { TraceFeedItem } from '../utils/trace-feed.js';

interface ToolActivity {
  kind: 'proposed' | 'executed' | 'denied';
  text: string;
}

interface ChatPanelProps {
  activeSessionId: string | null;
  text: string;
  onTextChange: (value: string) => void;
  onVoice: () => void;
  onAbortVoice: () => void;
  onAbortReply: () => void;
  onToggleVoiceMode: () => void;
  onSend: () => void;
  busy: boolean;
  voiceEnabled: boolean;
  voiceMode: boolean;
  voiceState: 'idle' | 'listening' | 'sending' | 'speaking';
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
      return '工具执行完成，设备状态已更新。';
    }

    if (command.type === 'start') {
      return `已执行启动指令：${command.channel ?? '通道'} 通道，强度 ${command.strength ?? 0}，波形 ${command.waveform?.id ?? '默认'}。`;
    }

    if (command.type === 'stop') {
      return `已执行停止指令：${command.channel ? `${command.channel} 通道` : '全部通道'}。`;
    }

    return '工具执行完成，设备状态已更新。';
  } catch {
    return '工具执行完成，设备状态已更新。';
  }
}

function isToolExecutionSummary(content: string): boolean {
  return content.startsWith('Fake LLM 已完成工具执行：');
}

export function ChatPanel({
  activeSessionId,
  text,
  onTextChange,
  onVoice,
  onAbortVoice,
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
}: ChatPanelProps) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const listening = voiceState === 'listening';
  const hasText = text.trim().length > 0;
  const messages = session?.messages ?? [];
  const timelineItems = buildRenderableTimeline(messages, traceFeed);
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_BATCH_SIZE);
  const renderedMessages = timelineItems.slice(-visibleMessageCount);
  const voiceModeAvailable = voiceEnabled && speechRecognitionSupported;
  const connectButtonLabel = deviceState.connected ? '重连设备' : '连接设备';
  const emergencyStopDisabled = !activeSessionId || !deviceState.connected;
  const primaryActionLabel = busy
    ? '停止回复'
    : hasText
      ? '发送'
      : voiceMode
        ? voiceState === 'listening'
          ? '停止语音'
          : '语音中'
        : voiceModeAvailable
          ? '语音模式'
          : '发送';
  const primaryActionDisabled = !activeSessionId || (!busy && !hasText && !voiceMode && !voiceModeAvailable);

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }, [text]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamingAssistantText, busy]);

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
    if (voiceMode || voiceModeAvailable) {
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

  return (
    <Card className="relative flex min-h-full w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none">
      <CardHeader className="relative z-20 gap-2 border-b border-[var(--surface-border)] bg-[var(--glass)] px-4 py-2.5 backdrop-blur-xl sm:px-6">
        <div className="flex min-h-9 w-full items-center justify-between gap-3 sm:grid sm:min-h-[46px] sm:grid-cols-[1fr_minmax(0,940px)_1fr] sm:items-center">
          <div className="hidden sm:block" />
          <div className="min-w-0 flex-1 sm:flex sm:w-full sm:justify-center">
            {deviceState.connected ? (
              <div className="grid w-full max-w-[420px] gap-2">
                {[
                  { label: 'A', value: deviceState.strengthA, max: maxStrengthA },
                  { label: 'B', value: deviceState.strengthB, max: maxStrengthB },
                ].map((channel) => (
                  <div
                    key={channel.label}
                    className="grid min-h-[18px] grid-cols-[18px_minmax(160px,1fr)_28px] items-center gap-2"
                  >
                    <span className="text-sm font-semibold text-[var(--accent)]">{channel.label}</span>
                    <div className="relative h-1 rounded-full bg-[var(--bg-soft)]">
                      <div
                        className="absolute top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-full bg-[var(--danger)]"
                        style={{
                          left: `calc(${Math.max(0, Math.min(100, (channel.max / DEVICE_STRENGTH_CAP) * 100))}% - 1px)`,
                        }}
                      />
                    </div>
                    <span className="text-right text-sm font-medium text-[var(--text-soft)]">{channel.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:ml-auto sm:justify-self-end">
            <Button
              variant="secondary"
              size="sm"
              className="h-9 w-9 rounded-[16px] border-[var(--surface-border)] bg-[var(--glass)] px-0 text-[13px] font-medium tracking-[-0.01em] text-[var(--text-soft)] shadow-none hover:bg-[var(--glass)] hover:text-[var(--text)] sm:h-9 sm:w-auto sm:gap-2.5 sm:px-3.5"
              disabled={!activeSessionId}
              onClick={onConnect}
              aria-label={connectButtonLabel}
            >
              <Bluetooth className="h-4 w-4" />
              <span className="hidden sm:inline">{connectButtonLabel}</span>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-9 w-9 rounded-[16px] px-0 text-[13px] font-medium tracking-[-0.01em] shadow-none sm:h-9 sm:w-auto sm:gap-2.5 sm:px-3.5"
              disabled={emergencyStopDisabled}
              onClick={onEmergencyStop}
              aria-label="紧急停止"
            >
              <OctagonX className="h-4 w-4" />
              <span className="hidden sm:inline">紧急停止</span>
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="main-content-scroll min-h-0 flex flex-1 flex-col overflow-y-auto px-4 pb-8 pt-3 [scrollbar-gutter:stable] sm:px-6">
        <div className="mx-auto flex min-h-full w-full max-w-[940px] flex-col gap-4 pb-4">
          {!busy && !streamingAssistantText && messages.length === 0 && (
            <div className="flex flex-1 items-center justify-center px-4 py-8 text-center">
              <div className="text-[clamp(1.9rem,4vw,3rem)] font-semibold tracking-[-0.05em] text-[var(--text)]">
                欢迎使用 DG-Agent ！
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
                  <div className="max-w-[85%] rounded-[8px] border-l-[3px] border-l-[var(--accent)] bg-[var(--accent-soft)] px-4 py-2 text-sm text-[var(--text-soft)]">
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
                  <div className="max-w-[85%] rounded-[8px] border-l-[3px] border-l-[var(--accent)] bg-[var(--accent-soft)] px-4 py-2 text-sm text-[var(--text-soft)]">
                    {message.content}
                  </div>
                </div>
              );
            }

            const userMessage = message.role === 'user';
            return (
              <div key={message.id} className={cn('flex', userMessage ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[92%] overflow-hidden break-all whitespace-pre-wrap px-4 py-3 text-[14.5px] leading-[1.6]',
                    userMessage
                      ? 'rounded-[14px] rounded-br-[4px] bg-[var(--accent)] text-[var(--button-text)]'
                      : 'rounded-[14px] rounded-bl-[4px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-[var(--text)]',
                  )}
                >
                  {message.content}
                </div>
              </div>
            );
          })}

          {streamingAssistantText && (
            <div className="flex justify-start">
              <div className="max-w-[92%] overflow-hidden break-all whitespace-pre-wrap rounded-[14px] rounded-bl-[4px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3 text-[14.5px] leading-[1.6] text-[var(--text)]">
                {streamingAssistantText}
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
          <div ref={messagesEndRef} className="h-40 shrink-0 sm:h-40" />
        </div>
      </CardContent>

      <CardFooter className="chat-footer-float z-30 px-4 pb-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-[940px] flex-col gap-2">
          <div className="rounded-[22px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-5 py-4 shadow-[var(--shadow)]">
            <div>
              <Textarea
                ref={composerRef}
                value={text}
                disabled={busy}
                rows={1}
                onChange={(event) => onTextChange(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="输入消息…"
                className="min-h-[32px] max-h-[140px] resize-none overflow-y-hidden border-0 bg-transparent px-0 py-0 text-[15px] leading-[1.6] shadow-none focus-visible:ring-0"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-[var(--surface-border)] pt-3">
              <Button
                variant="ghost"
                className="h-9 rounded-full px-3 text-[var(--text-soft)]"
                disabled={busy || !voiceEnabled || (!speechRecognitionSupported && !listening)}
                onClick={listening ? onAbortVoice : onVoice}
              >
                <Mic className="h-4 w-4" />
                <span>{listening ? '停止收音' : '语音'}</span>
              </Button>

              <Button
                variant={busy ? 'destructive' : !hasText && voiceModeAvailable ? 'secondary' : 'default'}
                size="icon"
                className="h-10 w-10 shrink-0 rounded-full"
                disabled={primaryActionDisabled}
                onClick={handlePrimaryAction}
                aria-label={primaryActionLabel}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardFooter>
    </Card>
  );
}

type TimelineItem =
  | (SessionSnapshot['messages'][number] & { kind: 'message' })
  | { kind: 'trace-system'; id: string; content: string; createdAt: number };

function buildRenderableTimeline(messages: SessionSnapshot['messages'], traceFeed: TraceFeedItem[]): TimelineItem[] {
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
