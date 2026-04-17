import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type BridgeLogEntry, type BridgeManagerStatus } from '@dg-agent/bridge-core';
import { createEmptyDeviceState, type PermissionDecision } from '@dg-agent/core';
import { BrowserAppSettingsStore, type BrowserAppSettings } from '@dg-agent/storage-browser';
import { BrowserSafetyGuard } from '@dg-agent/safety-browser';
import { applyTheme, subscribeThemeChanges } from '@dg-agent/theme-browser';
import type { UpdateCheckerStatus } from '@dg-agent/update-browser';
import { ChevronRight, X } from 'lucide-react';
import { BridgePanel } from './components/BridgePanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import { EventsPanel } from './components/EventsPanel.js';
import { PermissionModal } from './components/PermissionModal.js';
import { RuntimeStatusPanel } from './components/RuntimeStatusPanel.js';
import { SafetyNoticeModal } from './components/SafetyNoticeModal.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { SessionPanel } from './components/SessionPanel.js';
import { WaveformsPanel } from './components/WaveformsPanel.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useBrowserAppServices, type PendingPermissionRequest } from './composition/use-browser-app-services.js';
import { useRuntimeSessionState } from './hooks/use-runtime-session-state.js';
import { useVoiceController } from './hooks/use-voice-controller.js';
import { useWaveformManager } from './hooks/use-waveform-manager.js';
import { createSessionId, isReplyAbortError } from './utils/app-runtime-helpers.js';
import { buildWarnings } from './utils/runtime-warnings.js';
import { formatUiErrorMessage, getRecentToolActivities, isBluetoothChooserCancelledError } from './utils/ui-formatters.js';
import { buildTraceFeed } from './utils/trace-feed.js';

type InspectorTab = 'runtime' | 'settings' | 'waveforms' | 'bridge' | 'events';

function localizeToastText(text: string): string {
  if (/Device is not connected\./i.test(text)) {
    return '设备尚未连接。';
  }
  if (/Cold-start strength is capped at (\d+)/i.test(text)) {
    const match = text.match(/Cold-start strength is capped at (\d+)/i);
    return `冷启动强度上限为 ${match?.[1] ?? '10'}。`;
  }
  if (/Tool calls for this turn are capped at (\d+)/i.test(text)) {
    const match = text.match(/Tool calls for this turn are capped at (\d+)/i);
    return `当前轮次最多只能调用 ${match?.[1] ?? ''} 次工具。`;
  }
  if (/adjust_strength is capped at (\d+)/i.test(text)) {
    const match = text.match(/adjust_strength is capped at (\d+)/i);
    return `本轮 adjust_strength 最多只能调用 ${match?.[1] ?? ''} 次。`;
  }
  if (/burst is capped at (\d+)/i.test(text)) {
    const match = text.match(/burst is capped at (\d+)/i);
    return `本轮 burst 最多只能调用 ${match?.[1] ?? ''} 次。`;
  }
  if (/requires an already active channel/i.test(text)) {
    return '当前通道还没有运行，不能直接执行 burst，请先启动通道。';
  }
  if (/A mutating action requires permission\./i.test(text)) {
    return '该操作会修改设备状态，需要先获得权限。';
  }
  return text;
}

export function App() {
  const settingsStore = useMemo(
    () =>
      new BrowserAppSettingsStore({
        env: import.meta.env,
      }),
    [],
  );
  const initialSettings = useMemo(() => settingsStore.load(), [settingsStore]);
  const [settingsDraft, setSettingsDraft] = useState<BrowserAppSettings>(initialSettings);
  const [settings, setSettings] = useState<BrowserAppSettings>(initialSettings);
  const [pendingPermission, setPendingPermission] = useState<PendingPermissionRequest | null>(null);
  const [bridgeLogs, setBridgeLogs] = useState<BridgeLogEntry[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeManagerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [toastVisibility, setToastVisibility] = useState<Record<string, boolean>>({});
  const [safetyNoticeAccepted, setSafetyNoticeAccepted] = useState(() => !initialSettings.showSafetyNoticeOnStartup);
  const [text, setText] = useState('');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('runtime');
  const [controlOpen, setControlOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const {
    waveformLibrary,
    updateChecker,
    speechRecognition,
    speechSynthesizer,
    speechCapabilities,
    client,
    modes,
    bridgeManager,
    resetPermissionGrants,
  } = useBrowserAppServices({
    settings,
    setPendingPermission,
  });

  const [updateStatus, setUpdateStatus] = useState<UpdateCheckerStatus>(() => updateChecker.getStatus());
  const sendTextMessageRef = useRef<((message: string) => Promise<'sent' | 'aborted' | 'failed'>) | null>(null);

  const voice = useVoiceController({
    speechRecognition,
    speechSynthesizer,
    ttsEnabled: settings.ttsEnabled,
    sendTextMessageRef,
    setText,
    setErrorMessage,
    setStatusMessage,
  });

  const runtimeSession = useRuntimeSessionState({
    client,
    enabled: safetyNoticeAccepted,
    onRuntimeEvent: voice.handleRuntimeEvent,
  });

  const waveformManager = useWaveformManager({
    enabled: safetyNoticeAccepted,
    waveformLibrary,
    setErrorMessage,
    setStatusMessage,
  });

  const {
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
    streamingAssistantText,
    clearStreamingAssistantText,
    refreshCurrentSession,
  } = runtimeSession;

  const {
    voiceMode,
    voiceState,
    voiceTranscript,
    transcribeVoiceInput,
    abortVoiceCapture,
    toggleVoiceMode,
    stopSpeechPlayback,
    stopAllVoiceActivity,
  } = voice;

  const {
    waveforms,
    customWaveforms,
    editingWaveform,
    setEditingWaveform,
    importWaveformFiles,
    removeWaveform,
    openWaveformEditor,
    saveWaveformEdits,
  } = waveformManager;

  const safetyGuard = useMemo(
    () =>
      new BrowserSafetyGuard({
        stopOnLeave: settings.safetyStopOnLeave,
        backgroundBehavior: settings.backgroundBehavior,
        onStop: async (reason) => {
          await performLifecycleStop(reason);
        },
      }),
    [settings.backgroundBehavior, settings.safetyStopOnLeave],
  );

  useEffect(() => {
    applyTheme(settings.themeMode);
    return subscribeThemeChanges(settings.themeMode, () => {
      applyTheme(settings.themeMode);
    });
  }, [settings.themeMode]);

  useEffect(() => {
    if (!safetyNoticeAccepted) return;
    return safetyGuard.start();
  }, [safetyGuard, safetyNoticeAccepted]);

  useEffect(() => {
    const unsubscribe = updateChecker.subscribe(setUpdateStatus);
    updateChecker.start();
    return () => {
      unsubscribe();
      updateChecker.stop();
    };
  }, [updateChecker]);

  useEffect(() => {
    if (!safetyNoticeAccepted || !settings.bridge.enabled) return;

    let cancelled = false;
    const unsubscribeLogs = bridgeManager.subscribeLogs((entry) => {
      setBridgeLogs((current) => [entry, ...current].slice(0, 30));
    });
    const unsubscribeStatus = bridgeManager.subscribeStatus((status) => {
      setBridgeStatus(status);
    });

    void bridgeManager.start().catch((error) => {
      if (!cancelled) {
        setErrorMessage(formatUiErrorMessage(error));
      }
    });

    return () => {
      cancelled = true;
      unsubscribeLogs();
      unsubscribeStatus();
      void bridgeManager.stop();
    };
  }, [bridgeManager, safetyNoticeAccepted, settings.bridge.enabled]);

  const denyPendingPermissionRequest = useCallback((reason = '当前回复已停止。'): void => {
    if (!pendingPermission) return;
    pendingPermission.resolve({ type: 'deny', reason });
    setPendingPermission(null);
  }, [pendingPermission]);

  async function performLifecycleStop(reason: 'leave-page' | 'background-hidden'): Promise<void> {
    denyPendingPermissionRequest('当前回复已在页面离开前台时终止。');
    stopAllVoiceActivity({ disableMode: true });

    if (activeSessionId) {
      await client.abortCurrentReply(activeSessionId);
      await client.emergencyStop(activeSessionId);
    }

    if (reason === 'background-hidden') {
      setStatusMessage('应用切到后台后，已自动停止当前输出。');
    }
  }

  const connect = useCallback(async (): Promise<boolean> => {
    if (!activeSessionId) return false;

    try {
      setErrorMessage(null);
      await client.connectDevice(activeSessionId);
      setStatusMessage('设备已连接。');
      await refreshCurrentSession(activeSessionId);
      return true;
    } catch (error) {
      if (isBluetoothChooserCancelledError(error)) {
        setErrorMessage(null);
        setStatusMessage(liveDeviceState.connected ? '已取消重连，当前设备连接保持不变。' : '已取消设备选择，当前仍未连接设备。');
        return false;
      }
      setErrorMessage(formatUiErrorMessage(error));
      return false;
    }
  }, [activeSessionId, client, liveDeviceState.connected, refreshCurrentSession]);

  const disconnect = useCallback(async (): Promise<void> => {
    try {
      setErrorMessage(null);
      await client.disconnectDevice();
      setStatusMessage('设备已断开。');
      if (activeSessionId) {
        await refreshCurrentSession(activeSessionId);
      }
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }, [activeSessionId, client, refreshCurrentSession]);

  const sendTextMessage = useCallback(async (message: string): Promise<'sent' | 'aborted' | 'failed'> => {
    if (!message.trim() || !activeSessionId) return 'failed';

    setBusy(true);
    try {
      setErrorMessage(null);
      stopSpeechPlayback();

      await client.sendUserMessage({
        sessionId: activeSessionId,
        text: message,
        context: {
          sessionId: activeSessionId,
          sourceType: 'web',
          traceId: `web-${Date.now()}`,
        },
      });

      setStatusMessage('消息已发送。');
      await refreshCurrentSession(activeSessionId);
      return 'sent';
    } catch (error) {
      if (isReplyAbortError(error)) {
        setStatusMessage('已停止当前回复。');
        return 'aborted';
      }
      setErrorMessage(formatUiErrorMessage(error));
      return 'failed';
    } finally {
      setBusy(false);
    }
  }, [activeSessionId, client, refreshCurrentSession, stopSpeechPlayback]);

  useEffect(() => {
    sendTextMessageRef.current = sendTextMessage;
  }, [sendTextMessage]);

  async function send(): Promise<void> {
    const draft = text;
    if (!draft.trim()) return;

    setText('');
    const result = await sendTextMessage(draft);
    if (result === 'failed') {
      setText(draft);
    }
  }

  async function stop(): Promise<void> {
    if (!activeSessionId) return;

    try {
      setErrorMessage(null);
      denyPendingPermissionRequest('当前回复已通过紧急停止终止。');
      stopAllVoiceActivity({ disableMode: true });
      await client.abortCurrentReply(activeSessionId);
      await client.emergencyStop(activeSessionId);
      setStatusMessage('已发送紧急停止。');
      await refreshCurrentSession(activeSessionId);
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  async function abortCurrentReply(): Promise<void> {
    if (!activeSessionId) return;

    try {
      setErrorMessage(null);
      denyPendingPermissionRequest();
      stopSpeechPlayback();
      await client.abortCurrentReply(activeSessionId);
      clearStreamingAssistantText();
      setStatusMessage('已停止当前回复。');
    } catch (error) {
      if (isReplyAbortError(error)) {
        setStatusMessage('已停止当前回复。');
        return;
      }
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  async function createNewSession(): Promise<void> {
    const nextSettings = settingsStore.clearSessionPermissionModeOverride();
    setSettingsDraft(nextSettings);
    setSettings(nextSettings);
    resetPermissionGrants();

    if (activeSessionId) {
      try {
        denyPendingPermissionRequest('已因新建会话终止当前回复。');
        stopAllVoiceActivity({ disableMode: true });
        await client.abortCurrentReply(activeSessionId);
        await client.emergencyStop(activeSessionId);
      } catch (error) {
        setErrorMessage(formatUiErrorMessage(error));
      }
    }

    const nextSessionId = createSessionId();
    setActiveSessionId(nextSessionId);
    setText('');
    clearStreamingAssistantText();
    clearEvents();
    setErrorMessage(null);
    setStatusMessage('已创建新会话。');
    setSidebarOpen(false);

    const nextSession = await client.getSessionSnapshot(nextSessionId);
    setSession(nextSession);
    setSavedSessions(await client.listSessions());
  }

  async function deleteSession(sessionId: string): Promise<void> {
    try {
      await client.deleteSession(sessionId);
      const remaining = await client.listSessions();
      setSavedSessions(remaining);

      if (sessionId === activeSessionId) {
        const nextSessionId = remaining[0]?.id ?? createSessionId();
        setActiveSessionId(nextSessionId);
        setText('');
        clearStreamingAssistantText();
        stopAllVoiceActivity({ disableMode: false });
        clearEvents();
        setSession(await client.getSessionSnapshot(nextSessionId));
      }

      setStatusMessage('会话已删除。');
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  function selectSession(sessionId: string): void {
    if (sessionId === activeSessionId) return;
    resetPermissionGrants();
    setActiveSessionId(sessionId);
    setText('');
    clearStreamingAssistantText();
    stopAllVoiceActivity({ disableMode: false });
    setErrorMessage(null);
    setStatusMessage('已切换到所选会话。');
    setSidebarOpen(false);
  }

  function resetSettings(): void {
    const next = settingsStore.reset();
    setSettingsDraft(next);
    setSettings(next);
    setStatusMessage('设置已恢复默认值。');
    clearEvents();
  }

  function saveCurrentPromptPreset(): void {
    const prompt = settingsDraft.customPrompt.trim();
    if (!prompt) {
      setErrorMessage('请先输入自定义提示词，再保存预设。');
      return;
    }

    const name = window.prompt('请输入这组提示词的名称');
    if (!name?.trim()) return;

    const preset = {
      id: `saved-${Date.now().toString(36)}`,
      name: name.trim(),
      prompt,
    };

    setSettingsDraft((current) => ({
      ...current,
      promptPresetId: preset.id,
      savedPromptPresets: [preset, ...current.savedPromptPresets],
    }));
    setStatusMessage('已保存自定义提示词。');
  }

  function loadSavedPromptPreset(presetId: string): void {
    const preset = settingsDraft.savedPromptPresets.find((item) => item.id === presetId);
    if (!preset) return;

    setSettingsDraft((current) => ({
      ...current,
      promptPresetId: preset.id,
      customPrompt: preset.prompt,
    }));
    setStatusMessage(`已载入提示词：${preset.name}`);
  }

  function deleteSavedPromptPreset(presetId: string): void {
    setSettingsDraft((current) => {
      const nextSavedPresets = current.savedPromptPresets.filter((item) => item.id !== presetId);
      return {
        ...current,
        promptPresetId: current.promptPresetId === presetId ? 'gentle' : current.promptPresetId,
        savedPromptPresets: nextSavedPresets,
      };
    });
    setStatusMessage('已删除该自定义提示词。');
  }

  function openInspector(tab: InspectorTab): void {
    setInspectorTab(tab);
    setControlOpen(true);
  }

  const deviceState = liveDeviceState ?? createEmptyDeviceState();
  const warnings = buildWarnings(settings, modes, speechCapabilities);
  const toolActivities = getRecentToolActivities(events);
  const traceFeed = buildTraceFeed(sessionTrace);
  const errorToastItems = errorMessage
    ? [{ key: `error:${errorMessage}`, text: errorMessage, variant: 'destructive' as const }]
    : [];
  const warningToastItems = warnings.map((warning) => ({
    key: `warning:${warning}`,
    text: warning,
    variant: 'warning' as const,
  }));
  const eventToastItems = events
    .filter(
      (event) =>
        event.type === 'assistant-message-aborted',
    )
    .slice(0, 4)
    .map((event) => {
      switch (event.type) {
        case 'assistant-message-aborted':
          return {
            key: `event:aborted:${event.sessionId}:${event.message.id}`,
            text: '已停止当前回复。',
            variant: 'info' as const,
          };
      }
    });
  const autoDismissToastItems = [...errorToastItems, ...warningToastItems, ...eventToastItems];
  const autoDismissToastKey = autoDismissToastItems.map((item) => item.key).join('||');
  const visibleErrorItems = errorToastItems.filter((item) => toastVisibility[item.key] !== false);
  const visibleWarnings = warningToastItems.filter((item) => toastVisibility[item.key] !== false);
  const visibleEventToasts = eventToastItems.filter((item) => toastVisibility[item.key] !== false);

  useEffect(() => {
    setToastVisibility((current) => Object.fromEntries(autoDismissToastItems.map((item) => [item.key, current[item.key] ?? true])));

    const timers = autoDismissToastItems.map((item) =>
      window.setTimeout(() => {
        setToastVisibility((current) => (current[item.key] === false ? current : { ...current, [item.key]: false }));
      }, 4200),
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [autoDismissToastKey]);

  function handleControlOpenChange(nextOpen: boolean): void {
    if (controlOpen && !nextOpen && JSON.stringify(settingsDraft) !== JSON.stringify(settings)) {
      const next = settingsStore.save(settingsDraft);
      setSettings(next);
      setSettingsDraft(next);
    }

    setControlOpen(nextOpen);
  }

  function renderInspectorPanel() {
    switch (inspectorTab) {
      case 'settings':
        return (
          <SettingsPanel
            settingsDraft={settingsDraft}
            setSettingsDraft={setSettingsDraft}
            onSaveCurrentPromptPreset={saveCurrentPromptPreset}
            onLoadSavedPromptPreset={loadSavedPromptPreset}
            onDeleteSavedPromptPreset={deleteSavedPromptPreset}
            onResetSettings={resetSettings}
          />
        );
      case 'waveforms':
        return (
          <WaveformsPanel
            waveforms={waveforms}
            customWaveforms={customWaveforms}
            onImport={(files) => void importWaveformFiles(files)}
            onRemove={(id) => void removeWaveform(id)}
            onEdit={openWaveformEditor}
          />
        );
      case 'bridge':
        return <BridgePanel enabled={settings.bridge.enabled} bridgeStatus={bridgeStatus} bridgeLogs={bridgeLogs} />;
      case 'events':
        return <EventsPanel events={events} />;
      case 'runtime':
      default:
        return (
          <RuntimeStatusPanel
            client={client}
            modes={modes}
            settings={settings}
            bridgeStatus={bridgeStatus}
            activeSessionId={activeSessionId}
            deviceState={deviceState}
            voiceMode={voiceMode}
            voiceState={voiceState}
            speechCapabilities={speechCapabilities}
          />
        );
    }
  }

  function resolvePermission(decision: PermissionDecision): void {
    if (!pendingPermission) return;
    pendingPermission.resolve(decision);
    setPendingPermission(null);
  }

  function handleSafetyNoticeAccept(options: { dontShowAgain: boolean }): void {
    const nextSettings = settingsStore.save({
      ...settings,
      showSafetyNoticeOnStartup: !options.dontShowAgain,
    });
    setSettings(nextSettings);
    setSettingsDraft(nextSettings);
    setSafetyNoticeAccepted(true);
  }

  const floatingStatus =
    voiceMode || visibleErrorItems.length > 0 || visibleWarnings.length > 0 || visibleEventToasts.length > 0 || updateStatus.hasUpdate ? (
      <div
        className={[
          'pointer-events-none absolute inset-x-0 z-40 flex justify-center px-3',
          deviceState.connected ? 'top-[7.25rem]' : 'top-[5.25rem]',
        ].join(' ')}
      >
        <div className="flex w-full max-w-[940px] flex-col gap-3">
          {voiceMode && (
            <section className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] rounded-[12px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3 text-center shadow-[var(--shadow)]">
              <div className="text-sm font-medium text-[var(--text)]">语音状态：{voiceState}</div>
              <div className="mt-1 whitespace-normal break-words text-sm text-[var(--text-soft)]">
                {voiceTranscript || '正在等待你的语音输入…'}
              </div>
            </section>
          )}

          {visibleErrorItems.map((item) => (
            <div key={item.key} className="pointer-events-auto flex justify-center">
              <Alert variant={item.variant} className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]">
                <AlertDescription className="whitespace-normal break-words text-center">{item.text}</AlertDescription>
              </Alert>
            </div>
          ))}
          {visibleWarnings.map((item) => (
            <div key={item.key} className="pointer-events-auto flex justify-center">
              <Alert variant={item.variant} className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]">
                <AlertDescription className="whitespace-normal break-words text-center">{item.text}</AlertDescription>
              </Alert>
            </div>
          ))}
          {visibleEventToasts.map((item) => (
            <div key={item.key} className="pointer-events-auto flex justify-center">
              <Alert variant={item.variant} className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]">
                <AlertDescription className="whitespace-normal break-words text-center">{item.text}</AlertDescription>
              </Alert>
            </div>
          ))}

          {updateStatus.hasUpdate && (
            <div className="pointer-events-auto flex justify-center">
              <Alert variant="info" className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]">
                <AlertDescription className="whitespace-normal break-words text-center">检测到新版本。刷新页面可能会中断蓝牙连接与语音会话。</AlertDescription>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => updateChecker.dismiss()}>
                    稍后提醒
                  </Button>
                  <Button size="sm" onClick={() => window.location.reload()}>
                    立即刷新
                  </Button>
                </div>
              </Alert>
            </div>
          )}
        </div>
      </div>
    ) : null;

  return (
    <>
      <main className="relative flex h-[100dvh] min-h-[100dvh] flex-col overflow-hidden" aria-hidden={!safetyNoticeAccepted}>
        <div className="pointer-events-none fixed left-0 top-1/2 z-40 -translate-y-1/2 lg:hidden">
          <div className="pointer-events-auto">
            <Button
              variant="ghost"
              size="icon"
              className="h-14 w-7 rounded-l-none rounded-r-full border border-l-0 border-[var(--surface-border)] bg-[var(--bg-elevated)]/95 shadow-[var(--shadow)] backdrop-blur hover:bg-[var(--bg-strong)]"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开会话列表"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">

        {pendingPermission && (
          <PermissionModal
            summary={pendingPermission.input.summary}
            args={pendingPermission.input.args}
            onDeny={() => resolvePermission({ type: 'deny' })}
            onAllowOnce={() => resolvePermission({ type: 'approve-once' })}
            onAllowTimed={() => resolvePermission({ type: 'approve-scoped', expiresAt: Date.now() + 5 * 60_000 })}
            onAllowSession={() => resolvePermission({ type: 'approve-scoped' })}
          />
        )}

        {editingWaveform && (
          <section className="permission-modal-backdrop">
            <div className="permission-modal waveform-modal">
              <div className="panel-header">
                <h2>编辑波形</h2>
                <span className="panel-meta">{editingWaveform.id}</span>
              </div>
              <label className="settings">
                <span>名称</span>
                <Input
                  value={editingWaveform.name}
                  onChange={(event) =>
                    setEditingWaveform((current) =>
                      current
                        ? {
                            ...current,
                            name: event.target.value,
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label className="settings">
                <span>说明</span>
                <Textarea
                  rows={4}
                  value={editingWaveform.description}
                  onChange={(event) =>
                    setEditingWaveform((current) =>
                      current
                        ? {
                            ...current,
                            description: event.target.value,
                          }
                        : current,
                    )
                  }
                />
              </label>
              <div className="settings-actions">
                <Button variant="secondary" onClick={() => setEditingWaveform(null)}>
                  取消
                </Button>
                <Button onClick={() => void saveWaveformEdits()}>保存</Button>
              </div>
            </div>
          </section>
        )}

        <Sheet open={controlOpen} onOpenChange={handleControlOpenChange}>
          <SheetContent side="right" className="flex h-full max-w-[520px] flex-col overflow-hidden bg-[var(--bg-elevated)] p-5 [&>button]:hidden">
            <SheetHeader>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <SheetTitle>控制台</SheetTitle>
                  <SheetDescription className="mt-1.5">设置、波形、桥接和调试信息都收在这里。</SheetDescription>
                </div>
                <SheetClose className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2">
                  <X className="h-5 w-5" />
                  <span className="sr-only">关闭</span>
                </SheetClose>
              </div>
            </SheetHeader>

            <Tabs value={inspectorTab} onValueChange={(value) => setInspectorTab(value as InspectorTab)} className="mt-5 flex min-h-0 flex-1 flex-col control-tabs-shell">
              <TabsList className="control-tabs mt-4 mr-1 grid w-[calc(100%-0.25rem)] grid-cols-2 gap-0 lg:grid-cols-5">
                <TabsTrigger className="control-tab-trigger" value="runtime">运行</TabsTrigger>
                <TabsTrigger className="control-tab-trigger" value="settings">设置</TabsTrigger>
                <TabsTrigger className="control-tab-trigger" value="waveforms">波形</TabsTrigger>
                <TabsTrigger className="control-tab-trigger" value="bridge">桥接</TabsTrigger>
                <TabsTrigger className="control-tab-trigger" value="events">事件</TabsTrigger>
              </TabsList>

              <TabsContent value={inspectorTab} className="mt-5 min-h-0 flex-1 overflow-hidden">
                <ScrollArea className="h-full min-h-0 pr-1">
                  {renderInspectorPanel()}
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </SheetContent>
        </Sheet>

        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent
            side="left"
            className="flex h-full w-screen max-w-none flex-col overflow-hidden bg-[var(--bg-elevated)] p-0 sm:max-w-[420px] [&>button]:hidden"
          >
            <SheetHeader className="px-5 pt-5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <SheetTitle>历史记录</SheetTitle>
                  <SheetDescription className="mt-1.5">选择历史对话，或者新建一条会话。</SheetDescription>
                </div>
                <SheetClose className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2">
                  <X className="h-5 w-5" />
                  <span className="sr-only">关闭</span>
                </SheetClose>
              </div>
            </SheetHeader>
            <div className="mt-1 min-h-0 flex-1">
              <SessionPanel
                savedSessions={savedSessions}
                activeSessionId={activeSessionId}
                onSelectSession={selectSession}
                onDeleteSession={(sessionId) => void deleteSession(sessionId)}
                onCreateSession={() => void createNewSession()}
                onOpenSettings={() => openInspector('settings')}
              />
            </div>
          </SheetContent>
        </Sheet>

          <section
            className={[
              'grid min-h-0 flex-1 grid-cols-1 overflow-hidden transition-[grid-template-columns] duration-300 ease-out',
              sidebarCollapsed ? 'lg:grid-cols-[70px_minmax(0,1fr)]' : 'lg:grid-cols-[272px_minmax(0,1fr)]',
            ].join(' ')}
          >
          <aside className="hidden min-h-0 overflow-hidden border-r border-[var(--surface-border)] bg-[var(--bg-elevated)] transition-all duration-300 ease-out lg:block">
            <SessionPanel
              savedSessions={savedSessions}
              activeSessionId={activeSessionId}
              onSelectSession={selectSession}
              onDeleteSession={(sessionId) => void deleteSession(sessionId)}
              onCreateSession={() => void createNewSession()}
              onOpenSettings={() => openInspector('settings')}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
            />
          </aside>

          <section className="relative flex min-h-0 min-w-0 overflow-hidden">
            {floatingStatus}
            <ChatPanel
              activeSessionId={activeSessionId}
              text={text}
              statusMessage={statusMessage}
              onTextChange={setText}
              onVoice={() => void transcribeVoiceInput()}
              onAbortVoice={abortVoiceCapture}
              onAbortReply={() => void abortCurrentReply()}
              onToggleVoiceMode={() => void toggleVoiceMode()}
              onSend={() => void send()}
              busy={busy}
              voiceEnabled={settings.voiceInputEnabled}
              voiceMode={voiceMode}
              voiceState={voiceState}
              speechRecognitionSupported={speechCapabilities.recognitionSupported}
              session={session}
              traceFeed={traceFeed}
              streamingAssistantText={streamingAssistantText}
              deviceState={deviceState}
              maxStrengthA={settings.maxStrengthA}
              maxStrengthB={settings.maxStrengthB}
              toolActivities={toolActivities}
              onConnect={() => void connect()}
              onEmergencyStop={() => void stop()}
            />
          </section>
        </section>
        </div>
      </main>

      {!safetyNoticeAccepted && <SafetyNoticeModal onAccept={handleSafetyNoticeAccept} />}
    </>
  );
}
