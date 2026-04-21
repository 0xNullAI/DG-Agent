import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BridgeLogEntry,
  type BridgeManagerStatus,
  type MessageOrigin,
} from '@dg-agent/bridge-core';
import { createEmptyDeviceState, type PermissionDecision } from '@dg-agent/core';
import { BrowserSafetyGuard } from '@dg-agent/safety-browser';
import { applyTheme, subscribeThemeChanges } from '@dg-agent/theme-browser';
import type { UpdateCheckerStatus } from '@dg-agent/update-browser';
import { X } from 'lucide-react';
import { ChatPanel } from './components/ChatPanel.js';
import { PermissionModal } from './components/PermissionModal.js';
import { SafetyNoticeModal } from './components/SafetyNoticeModal.js';
import { PresetSelector } from './components/PresetSelector.js';
import { SessionPanel } from './components/SessionPanel.js';
import { WaveformsPanel } from './components/WaveformsPanel.js';
import { GeneralTab } from './components/settings/GeneralTab.js';
import { SafetyTab } from './components/settings/SafetyTab.js';
import { BridgeTab } from './components/settings/BridgeTab.js';
import { VoiceTab } from './components/settings/VoiceTab.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

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
import {
  useBrowserAppServices,
  type PendingPermissionRequest,
} from './composition/use-browser-app-services.js';
import { useRuntimeSessionState } from './hooks/use-runtime-session-state.js';
import { useSettingsManager } from './hooks/use-settings-manager.js';
import { useToastManager } from './hooks/use-toast-manager.js';
import { useVoiceController } from './hooks/use-voice-controller.js';
import { useWaveformManager } from './hooks/use-waveform-manager.js';
import { createSessionId, isReplyAbortError } from './utils/app-runtime-helpers.js';
import { buildWarnings } from './utils/runtime-warnings.js';
import {
  formatUiErrorMessage,
  getRecentToolActivities,
  isBluetoothChooserCancelledError,
} from './utils/ui-formatters.js';
import { buildTraceFeed } from './utils/trace-feed.js';

type SettingsModalTab = 'general' | 'preset' | 'safety' | 'waveforms' | 'bridge' | 'voice';

function formatVoiceStateLabel(voiceState: 'idle' | 'listening' | 'speaking'): string {
  switch (voiceState) {
    case 'listening':
      return '录音中';
    case 'speaking':
      return '朗读中';
    case 'idle':
    default:
      return '空闲';
  }
}

export function App() {
  const activeSessionIdRef = useRef<string | null>(null);
  const bridgeSessionResolverRef = useRef<
    (origin: MessageOrigin) => Promise<string | null> | string | null
  >(() => activeSessionIdRef.current);
  const resolveBridgeSessionId = useCallback(
    (origin: MessageOrigin) => bridgeSessionResolverRef.current(origin),
    [],
  );

  const {
    settingsDraft,
    setSettingsDraft,
    settings,
    setSettings,
    settingsStore,
    savePromptDialogOpen,
    setSavePromptDialogOpen,
    promptPresetName,
    setPromptPresetName,
    resetSettings: resetSettingsManager,
    saveCurrentPromptPreset: saveCurrentPromptPresetManager,
    confirmSaveCurrentPromptPreset: confirmSaveCurrentPromptPresetManager,
    deleteSavedPromptPreset: deleteSavedPromptPresetManager,
    flushSettingsDraft,
    clearSessionPermissionOverride,
  } = useSettingsManager();

  const [pendingPermission, setPendingPermission] = useState<PendingPermissionRequest | null>(null);
  const [bridgeLogs, setBridgeLogs] = useState<BridgeLogEntry[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeManagerStatus | null>(null);
  const [pendingSend, setPendingSend] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [safetyNoticeAccepted, setSafetyNoticeAccepted] = useState(
    () => !settings.showSafetyNoticeOnStartup,
  );
  const [text, setText] = useState('');
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsModalTab, setSettingsModalTab] = useState<SettingsModalTab>('general');
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
    resolveBridgeSessionId,
    settings,
    setPendingPermission,
  });

  const [updateStatus, setUpdateStatus] = useState<UpdateCheckerStatus>(() =>
    updateChecker.getStatus(),
  );

  const voice = useVoiceController({
    speechRecognition,
    speechSynthesizer,
    ttsEnabled: settings.ttsEnabled,
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
    replyBusy,
    streamingAssistantText,
    clearStreamingAssistantText,
    refreshCurrentSession,
  } = runtimeSession;

  const busy = pendingSend || replyBusy;
  const deviceState = liveDeviceState ?? createEmptyDeviceState();
  const warnings = buildWarnings(settings, modes, speechCapabilities);
  const toolActivities = getRecentToolActivities(events);
  const traceFeed = buildTraceFeed(sessionTrace);

  const { visibleErrorItems, visibleWarnings, visibleEventToasts, hasVisibleToasts } =
    useToastManager({ errorMessage, warnings, events });

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    bridgeSessionResolverRef.current = async (_origin) => {
      const currentSessionId = activeSessionIdRef.current;
      if (currentSessionId) {
        return currentSessionId;
      }

      const nextSessionId = createSessionId();
      activeSessionIdRef.current = nextSessionId;
      setActiveSessionId(nextSessionId);
      await refreshCurrentSession(nextSessionId);
      return nextSessionId;
    };
  }, [refreshCurrentSession, setActiveSessionId]);

  const {
    voiceMode,
    voiceState,
    voiceTranscript,
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
        stopOnLeave: true,
        backgroundBehavior: settings.backgroundBehavior,
        onStop: async (reason) => {
          await performLifecycleStop(reason);
        },
      }),
    [settings.backgroundBehavior],
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

    void (async () => {
      try {
        await bridgeManager.start();
        if (cancelled) return;
        const status = bridgeManager.getStatus();
        if (status.adapters.length === 0) {
          setStatusMessage('桥接已启用，但当前没有可用的桥接通道');
          return;
        }
        setStatusMessage('桥接已启动');
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(formatUiErrorMessage(error));
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribeLogs();
      unsubscribeStatus();
      void bridgeManager.stop();
    };
  }, [bridgeManager, safetyNoticeAccepted, settings.bridge.enabled]);

  const denyPendingPermissionRequest = useCallback(
    (reason = '当前回复已停止'): void => {
      if (!pendingPermission) return;
      pendingPermission.resolve({ type: 'deny', reason });
      setPendingPermission(null);
    },
    [pendingPermission],
  );

  async function performLifecycleStop(reason: 'leave-page' | 'background-hidden'): Promise<void> {
    denyPendingPermissionRequest('当前回复已在页面离开前台时终止');
    stopAllVoiceActivity({ disableMode: true });

    if (activeSessionId) {
      await client.abortCurrentReply(activeSessionId);
      await client.emergencyStop(activeSessionId);
    }

    if (reason === 'background-hidden') {
      setStatusMessage('应用切到后台后，已自动停止当前输出');
    }
  }

  const connect = useCallback(async (): Promise<boolean> => {
    if (!activeSessionId) return false;

    try {
      setErrorMessage(null);
      await client.connectDevice(activeSessionId);
      setStatusMessage('设备已连接');
      await refreshCurrentSession(activeSessionId);
      return true;
    } catch (error) {
      if (isBluetoothChooserCancelledError(error)) {
        setErrorMessage(null);
        setStatusMessage(
          liveDeviceState.connected
            ? '已取消重连，当前设备连接保持不变'
            : '已取消设备选择，当前仍未连接设备',
        );
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
      setStatusMessage('设备已断开');
      if (activeSessionId) {
        await refreshCurrentSession(activeSessionId);
      }
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }, [activeSessionId, client, refreshCurrentSession]);

  const sendTextMessage = useCallback(
    async (message: string): Promise<'sent' | 'aborted' | 'failed'> => {
      if (!message.trim() || !activeSessionId) return 'failed';

      setPendingSend(true);
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

        setStatusMessage('消息已发送');
        await refreshCurrentSession(activeSessionId);
        return 'sent';
      } catch (error) {
        if (isReplyAbortError(error)) {
          setStatusMessage('已停止当前回复');
          return 'aborted';
        }
        setErrorMessage(formatUiErrorMessage(error));
        return 'failed';
      } finally {
        setPendingSend(false);
      }
    },
    [activeSessionId, client, refreshCurrentSession, stopSpeechPlayback],
  );

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
      denyPendingPermissionRequest('当前回复已通过紧急停止终止');
      stopAllVoiceActivity({ disableMode: true });
      await client.abortCurrentReply(activeSessionId);
      await client.emergencyStop(activeSessionId);
      setStatusMessage('已发送紧急停止');
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
      setStatusMessage('已停止当前回复');
    } catch (error) {
      if (isReplyAbortError(error)) {
        setStatusMessage('已停止当前回复');
        return;
      }
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  async function createNewSession(): Promise<void> {
    clearSessionPermissionOverride();
    resetPermissionGrants();

    if (activeSessionId) {
      try {
        denyPendingPermissionRequest('已因新建会话终止当前回复');
        stopAllVoiceActivity({ disableMode: true });
        await client.abortCurrentReply(activeSessionId);
      } catch (error) {
        if (!isReplyAbortError(error)) {
          setErrorMessage(formatUiErrorMessage(error));
        }
      }

      try {
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
    setStatusMessage('已创建新会话');
    setSidebarOpen(false);

    await refreshCurrentSession(nextSessionId);
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

      setStatusMessage('会话已删除');
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
    setStatusMessage('已切换到所选会话');
    setSidebarOpen(false);
  }

  function resetSettings(): void {
    resetSettingsManager(() => {
      setStatusMessage('设置已恢复默认值');
      clearEvents();
    });
  }

  function saveCurrentPromptPreset(): void {
    saveCurrentPromptPresetManager(setErrorMessage);
  }

  function confirmSaveCurrentPromptPreset(): void {
    confirmSaveCurrentPromptPresetManager(setErrorMessage, setStatusMessage);
  }

  function deleteSavedPromptPreset(presetId: string): void {
    deleteSavedPromptPresetManager(presetId, setStatusMessage);
  }

  function openSettingsModal(tab: SettingsModalTab = 'general'): void {
    setSettingsModalTab(tab);
    setSettingsModalOpen(true);
  }

  function handleSettingsModalOpenChange(nextOpen: boolean): void {
    if (settingsModalOpen && !nextOpen) {
      flushSettingsDraft();
    }
    if (!nextOpen) {
      setEditingWaveform(null);
    }
    setSettingsModalOpen(nextOpen);
  }

  function renderSettingsTabContent() {
    switch (settingsModalTab) {
      case 'general':
        return <GeneralTab settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} />;
      case 'preset':
        return (
          <PresetSelector
            settingsDraft={settingsDraft}
            setSettingsDraft={setSettingsDraft}
            onSaveCurrentPromptPreset={saveCurrentPromptPreset}
            onDeleteSavedPromptPreset={deleteSavedPromptPreset}
          />
        );
      case 'safety':
        return <SafetyTab settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} />;
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
        return <BridgeTab settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} />;
      case 'voice':
        return <VoiceTab settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} />;
      default:
        return null;
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
    voiceMode || hasVisibleToasts || updateStatus.hasUpdate ? (
      <div className="pointer-events-none absolute inset-x-0 top-[3.5rem] z-40 flex justify-center px-3">
        <div className="flex w-full max-w-[800px] flex-col gap-3">
          {voiceMode && (
            <section className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] rounded-[12px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3 text-center shadow-[var(--shadow)]">
              <div className="text-sm font-medium text-[var(--text)]">
                语音状态：{formatVoiceStateLabel(voiceState)}
              </div>
              <div className="mt-1 whitespace-normal break-words text-sm text-[var(--text-soft)]">
                {voiceTranscript || '正在等待你的语音输入…'}
              </div>
            </section>
          )}

          {visibleErrorItems.map((item) => (
            <div key={item.key} className="pointer-events-auto flex justify-center">
              <Alert
                variant={item.variant}
                className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]"
              >
                <AlertDescription className="whitespace-normal break-words text-center">
                  {item.text}
                </AlertDescription>
              </Alert>
            </div>
          ))}
          {visibleWarnings.map((item) => (
            <div key={item.key} className="pointer-events-auto flex justify-center">
              <Alert
                variant={item.variant}
                className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]"
              >
                <AlertDescription className="whitespace-normal break-words text-center">
                  {item.text}
                </AlertDescription>
              </Alert>
            </div>
          ))}
          {visibleEventToasts.map((item) => (
            <div key={item.key} className="pointer-events-auto flex justify-center">
              <Alert
                variant={item.variant}
                className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]"
              >
                <AlertDescription className="whitespace-normal break-words text-center">
                  {item.text}
                </AlertDescription>
              </Alert>
            </div>
          ))}

          {updateStatus.hasUpdate && (
            <div className="pointer-events-auto flex justify-center">
              <Alert
                variant="info"
                className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]"
              >
                <AlertDescription className="whitespace-normal break-words text-center">
                  检测到新版本，刷新页面可能会中断蓝牙连接与语音会话
                </AlertDescription>
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
      <main
        className="relative flex h-[100dvh] min-h-[100dvh] flex-col overflow-hidden"
        aria-hidden={!safetyNoticeAccepted}
      >
        {pendingPermission && (
          <PermissionModal
            summary={pendingPermission.input.summary}
            args={pendingPermission.input.args}
            onDeny={() => resolvePermission({ type: 'deny' })}
            onAllowOnce={() => resolvePermission({ type: 'approve-once' })}
            onAllowTimed={() =>
              resolvePermission({ type: 'approve-scoped', expiresAt: Date.now() + 5 * 60_000 })
            }
            onAllowSession={() => resolvePermission({ type: 'approve-scoped' })}
          />
        )}

        {/* Save prompt dialog */}
        <Dialog
          open={savePromptDialogOpen}
          onOpenChange={(open) => {
            setSavePromptDialogOpen(open);
            if (!open) {
              setPromptPresetName('');
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>保存提示词</DialogTitle>
              <DialogDescription>
                给当前这组自定义提示词起一个名称，之后可以在设置里快速复用
              </DialogDescription>
            </DialogHeader>

            <form
              className="mt-4 flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                confirmSaveCurrentPromptPreset();
              }}
            >
              <label className="flex flex-col gap-2">
                <span className="text-sm text-[var(--text-soft)]">提示词名称</span>
                <Input
                  value={promptPresetName}
                  onChange={(event) => setPromptPresetName(event.target.value)}
                  placeholder="例如：温柔引导 / 强刺激谨慎版"
                  autoFocus
                />
              </label>

              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setSavePromptDialogOpen(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={!promptPresetName.trim()}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Waveform editor dialog */}
        <Dialog
          open={Boolean(editingWaveform)}
          onOpenChange={(open) => {
            if (!open) {
              setEditingWaveform(null);
            }
          }}
        >
          {editingWaveform && (
            <DialogContent
              overlayClassName="bg-black/18 backdrop-blur-[2px]"
              className="max-w-[680px] overflow-hidden p-0"
            >
              <div className="panel-header">
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-[1.1rem] tracking-[-0.03em]">编辑波形</DialogTitle>
                  <DialogDescription className="mt-1">修改自定义波形的名称和说明</DialogDescription>
                </div>
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
              <div className="settings-actions waveform-modal-actions mt-2 mb-5">
                <Button variant="secondary" onClick={() => setEditingWaveform(null)}>
                  取消
                </Button>
                <Button onClick={() => void saveWaveformEdits()}>保存</Button>
              </div>
            </DialogContent>
          )}
        </Dialog>

        {/* ===== Settings modal (centered dialog, not side sheet) ===== */}
        <Dialog open={settingsModalOpen} onOpenChange={handleSettingsModalOpenChange}>
          <DialogContent
            overlayClassName="bg-black/18 backdrop-blur-[2px]"
            className="flex max-h-[85vh] w-[calc(100%-1rem)] max-w-[720px] flex-col overflow-hidden p-0 sm:w-[calc(100%-2rem)]"
          >
            <div className="flex items-center justify-between border-b border-[var(--surface-border)] px-4 py-3 sm:px-6 sm:py-4">
              <div>
                <DialogTitle className="text-[1.1rem] tracking-[-0.03em]">设置</DialogTitle>
                <DialogDescription className="mt-1">设置、波形、桥接和调试信息</DialogDescription>
              </div>
            </div>

            <Tabs
              value={settingsModalTab}
              onValueChange={(value) => setSettingsModalTab(value as SettingsModalTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="px-3 sm:px-6">
                <TabsList className="control-tabs grid w-full grid-cols-3 gap-0 bg-transparent sm:grid-cols-6">
                  <TabsTrigger className="control-tab-trigger" value="general">
                    基础
                  </TabsTrigger>
                  <TabsTrigger className="control-tab-trigger" value="preset">
                    场景
                  </TabsTrigger>
                  <TabsTrigger className="control-tab-trigger" value="safety">
                    安全
                  </TabsTrigger>
                  <TabsTrigger className="control-tab-trigger" value="waveforms">
                    波形
                  </TabsTrigger>
                  <TabsTrigger className="control-tab-trigger" value="bridge">
                    Bot
                  </TabsTrigger>
                  <TabsTrigger className="control-tab-trigger" value="voice">
                    语音
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent
                value={settingsModalTab}
                className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
              >
                <div className="settings settings-grouped settings-panel-body">
                  {renderSettingsTabContent()}
                </div>
                <div className="text-sm mt-6 flex justify-end">
                  <Button variant="secondary" onClick={resetSettings}>
                    恢复默认
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>

        {/* ===== Sidebar sheet (mobile) ===== */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent
            side="left"
            className="flex h-full w-screen max-w-none flex-col overflow-hidden bg-[var(--bg-elevated)] p-0 sm:max-w-[420px] [&>button]:hidden"
          >
            <SheetHeader className="px-5 pt-5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <SheetTitle>历史记录</SheetTitle>
                  <SheetDescription className="mt-1.5">
                    选择历史对话，或者新建一条会话
                  </SheetDescription>
                </div>
                <SheetClose className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2">
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
                onOpenSettings={() => openSettingsModal()}
                detached={true}
              />
            </div>
          </SheetContent>
        </Sheet>

        {/* ===== Main layout ===== */}
        <section
          className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-300 ease-out lg:grid-cols-[var(--sidebar-w)_minmax(0,1fr)]"
          style={{ '--sidebar-w': sidebarCollapsed ? '65px' : '272px' } as React.CSSProperties}
        >
          {/* Desktop sidebar */}
          <aside className="hidden min-h-0 overflow-hidden border-r border-[var(--surface-border)] bg-[var(--bg-elevated)] lg:block">
            <SessionPanel
              savedSessions={savedSessions}
              activeSessionId={activeSessionId}
              onSelectSession={selectSession}
              onDeleteSession={(sessionId) => void deleteSession(sessionId)}
              onCreateSession={() => void createNewSession()}
              onOpenSettings={() => openSettingsModal()}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
              detached={false}
            />
          </aside>

          {/* Chat section */}
          <section className="relative flex min-h-0 min-w-0 overflow-hidden">
            {floatingStatus}
            <ChatPanel
              activeSessionId={activeSessionId}
              text={text}
              statusMessage={statusMessage}
              onTextChange={setText}
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
              onOpenSidebar={() => setSidebarOpen(true)}
              onOpenSettings={() => openSettingsModal('general')}
            />
          </section>
        </section>
      </main>

      {!safetyNoticeAccepted && <SafetyNoticeModal onAccept={handleSafetyNoticeAccept} />}
    </>
  );
}
