import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BridgeLogEntry,
  type BridgeManagerStatus,
  type MessageOrigin,
} from '@dg-agent/bridge';
import {
  createEmptyDeviceState,
  createEmptySensorState,
  type PermissionDecision,
} from '@dg-agent/core';
import { connectAnyDgLabDevice } from '@dg-agent/agent-browser';
import { createEmptyOpossumState } from '@dg-agent/device-webbluetooth';
import { BrowserSafetyGuard } from './services/safety-guard.js';
import { applyTheme, subscribeThemeChanges } from './services/theme.js';
import type { UpdateCheckerStatus } from './services/update-checker.js';
import { X } from 'lucide-react';
import { BUILTIN_PROMPT_PRESETS, DEVICE_KIND_DISPLAY_NAME } from '@dg-agent/runtime';
import { ChatPanel } from './components/ChatPanel.js';
import { PermissionModal } from './components/PermissionModal.js';
import { SafetyNoticeModal } from './components/SafetyNoticeModal.js';
import { SessionPanel } from './components/SessionPanel.js';
import { FloatingStatusBar } from './components/FloatingStatusBar.js';
import { WaveformEditorDialog } from './components/WaveformEditorDialog.js';
import { ResetSettingsDialog } from './components/ResetSettingsDialog.js';
import {
  SettingsSidebar,
  SettingsWorkspace,
  type SettingsModalTab,
} from './components/SettingsDrawer.js';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  useBrowserAppServices,
  type PendingPermissionRequest,
  type ServicesOverrides,
} from './composition/use-browser-app-services.js';
import { useAuxDeviceState } from './hooks/use-aux-device-state.js';
import { useModelLog } from './hooks/use-model-log.js';
import { useRuntimeSessionState } from './hooks/use-runtime-session-state.js';
import { useSettingsManager } from './hooks/use-settings-manager.js';
import { useToastManager } from './hooks/use-toast-manager.js';
import { useVoiceController } from './hooks/use-voice-controller.js';
import { useWaveformManager } from './hooks/use-waveform-manager.js';
import { createSessionId, isReplyAbortError } from './utils/app-runtime-helpers.js';
import { buildWarnings } from './utils/runtime-warnings.js';
import {
  formatUiErrorMessage,
  getSessionTitle,
  isBluetoothChooserCancelledError,
} from './utils/ui-formatters.js';
import { buildTraceFeed } from './utils/trace-feed.js';
import {
  parseSessionsFromJson,
  serializeSessionFile,
  sessionFileName,
} from './utils/session-transfer.js';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { SessionSnapshot } from '@dg-agent/core';

export interface AppProps {
  /**
   * Optional override for service construction. Web entry omits this to keep
   * the historical Web Bluetooth + speech + bridge defaults; the Tauri Android
   * shell supplies a Tauri device factory and disables speech/bridge.
   */
  servicesOverrides?: ServicesOverrides;
}

export function App({ servicesOverrides }: AppProps = {}) {
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
    resetSettings: resetSettingsManager,
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
  const [settingsMobileNavOpen, setSettingsMobileNavOpen] = useState(false);
  const [resetSettingsDialogOpen, setResetSettingsDialogOpen] = useState(false);
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
    serviceInitWarnings,
    resetPermissionGrants,
    device,
    opossum,
    pawPrints,
    civetEdging,
  } = useBrowserAppServices({
    resolveBridgeSessionId,
    settings,
    setPendingPermission,
    servicesOverrides,
  });

  const [updateStatus, setUpdateStatus] = useState<UpdateCheckerStatus>(() =>
    updateChecker.getStatus(),
  );

  const voice = useVoiceController({
    speechRecognition,
    speechSynthesizer,
    speechSynthesisEnabled: settings.speechSynthesisEnabled,
    setText,
    setErrorMessage,
    setStatusMessage,
  });

  const modelLog = useModelLog(settings.modelLogEnabled);

  const runtimeSession = useRuntimeSessionState({
    client,
    enabled: safetyNoticeAccepted,
    onRuntimeEvent: useCallback(
      (event) => {
        voice.handleRuntimeEvent(event);
        modelLog.ingest(event);
      },
      [voice, modelLog],
    ),
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
    liveTraceItems,
    refreshCurrentSession,
  } = runtimeSession;

  const busy = pendingSend || replyBusy;
  const deviceState = liveDeviceState ?? createEmptyDeviceState();
  const opossumState = useAuxDeviceState(opossum, createEmptyOpossumState());
  const pawPrintsState = useAuxDeviceState(pawPrints, createEmptySensorState());
  const civetEdgingState = useAuxDeviceState(civetEdging, createEmptySensorState());

  const [sensorTriggersEnabled, setSensorTriggersEnabledState] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() =>
        activeSessionId ? client.isSensorTriggersEnabledForSession(activeSessionId) : false,
      )
      .then((enabled) => {
        if (!cancelled) setSensorTriggersEnabledState(enabled);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, client]);
  const toggleSensorTriggers = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!activeSessionId) return;
      try {
        await client.setSensorTriggersEnabled(activeSessionId, enabled);
        setSensorTriggersEnabledState(enabled);
      } catch (error) {
        setErrorMessage(formatUiErrorMessage(error));
      }
    },
    [activeSessionId, client],
  );
  const warnings = [
    ...buildWarnings(settings, modes, speechCapabilities, {
      suppressBridge: servicesOverrides?.disableBridge,
      suppressSpeech: servicesOverrides?.disableSpeech,
    }),
    ...serviceInitWarnings,
  ];
  const historicalTraceFeed = buildTraceFeed(sessionTrace);
  const traceFeed =
    liveTraceItems.length > 0
      ? [...historicalTraceFeed, ...liveTraceItems].sort((a, b) => a.createdAt - b.createdAt)
      : historicalTraceFeed;

  const { visibleErrorItems, visibleWarnings, visibleEventToasts } = useToastManager({
    errorMessage,
    warnings,
    events,
  });

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
    importWaveformFromMarket,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * Single unified connect entry point: one chooser scoped to all four
   * DG-Lab device kinds, auto-detected and routed to the right client.
   * Click again to add another device — each call opens its own chooser
   * (Web Bluetooth's own security model requires an explicit click per
   * prompt, never auto-repeated).
   */
  const connect = useCallback(async (): Promise<boolean> => {
    if (!activeSessionId) return false;

    try {
      setErrorMessage(null);
      const { kind } = await connectAnyDgLabDevice({ device, opossum, pawPrints, civetEdging });
      setStatusMessage(`${DEVICE_KIND_DISPLAY_NAME[kind]}已连接`);
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
  }, [
    activeSessionId,
    device,
    opossum,
    pawPrints,
    civetEdging,
    liveDeviceState.connected,
    refreshCurrentSession,
  ]);

  const _disconnect = useCallback(async (): Promise<void> => {
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

  const disconnectOpossum = useCallback(async (): Promise<void> => {
    try {
      await opossum.disconnect();
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }, [opossum]);

  const disconnectPawPrints = useCallback(async (): Promise<void> => {
    try {
      await pawPrints.disconnect();
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }, [pawPrints]);

  const disconnectCivetEdging = useCallback(async (): Promise<void> => {
    try {
      await civetEdging.disconnect();
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }, [civetEdging]);

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
    closeSettingsWorkspace();
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

  function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // Export the chosen sessions as a zip with one JSON file per session.
  async function exportSessions(sessionIds: string[]): Promise<void> {
    try {
      const all = await client.listSessions();
      const chosen = all.filter((session) => sessionIds.includes(session.id));
      if (chosen.length === 0) {
        setStatusMessage('请选择要导出的会话');
        return;
      }
      const exportedAt = Date.now();
      const files: Record<string, Uint8Array> = {};
      for (const session of chosen) {
        let name = sessionFileName(session);
        // Guard against (unlikely) filename collisions inside the zip.
        for (let i = 2; name in files; i += 1) {
          name = sessionFileName(session).replace(/\.json$/, `-${i}.json`);
        }
        files[name] = strToU8(serializeSessionFile(session, exportedAt));
      }
      const zipped = zipSync(files);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      triggerDownload(
        new Blob([zipped], { type: 'application/zip' }),
        `dg-agent-chat-${stamp}.zip`,
      );
      setStatusMessage(`已导出 ${chosen.length} 个会话`);
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  // Import from a zip (one JSON per session) or a single JSON file.
  async function importSessions(file: File): Promise<void> {
    try {
      const sessions: SessionSnapshot[] = [];
      if (/\.zip$/i.test(file.name)) {
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
        for (const [name, content] of Object.entries(entries)) {
          if (!/\.json$/i.test(name)) continue;
          sessions.push(...parseSessionsFromJson(strFromU8(content)));
        }
      } else {
        sessions.push(...parseSessionsFromJson(await file.text()));
      }
      if (sessions.length === 0) {
        setStatusMessage('文件中没有会话');
        return;
      }
      await client.importSessions(sessions);
      setSavedSessions(await client.listSessions());
      setStatusMessage(`已导入 ${sessions.length} 个会话`);
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  function selectSession(sessionId: string): void {
    if (sessionId === activeSessionId) {
      if (settingsModalOpen) closeSettingsWorkspace();
      return;
    }
    closeSettingsWorkspace();
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

  function deleteSavedPromptPreset(presetId: string): void {
    deleteSavedPromptPresetManager(presetId, setStatusMessage);
  }

  function openSettingsModal(tab: SettingsModalTab = 'general'): void {
    setSettingsModalTab(tab);
    setSettingsModalOpen(true);
    setSettingsMobileNavOpen(true);
    setSidebarOpen(false);
  }

  function closeSettingsWorkspace(): void {
    if (settingsModalOpen) {
      flushSettingsDraft();
    }
    setEditingWaveform(null);
    setSettingsMobileNavOpen(false);
    setSettingsModalOpen(false);
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

  return (
    <>
      <main
        className="relative flex h-[100dvh] min-h-[100dvh] flex-col overflow-hidden pt-[env(safe-area-inset-top)]"
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

        <WaveformEditorDialog
          editingWaveform={editingWaveform}
          onEditingWaveformChange={setEditingWaveform}
          onSave={saveWaveformEdits}
        />

        <ResetSettingsDialog
          open={resetSettingsDialogOpen}
          onOpenChange={setResetSettingsDialogOpen}
          onConfirm={resetSettings}
        />

        {/* ===== Sidebar sheet (mobile) ===== */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent
            side="left"
            className="dg-sidebar-sheet flex h-full w-screen max-w-none flex-col overflow-hidden bg-[var(--bg-elevated)] p-0 pt-[env(safe-area-inset-top)] sm:max-w-[420px] [&>button]:hidden"
          >
            <SheetHeader className="px-5 pt-5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <SheetTitle>历史记录</SheetTitle>
                  <SheetDescription className="sr-only">
                    选择历史对话，或者新建一条会话
                  </SheetDescription>
                </div>
                <SheetClose className="scale-90 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-[var(--surface-border)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2">
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
          style={
            {
              '--sidebar-w': settingsModalOpen ? '272px' : sidebarCollapsed ? '65px' : '272px',
            } as React.CSSProperties
          }
        >
          {/* Desktop sidebar */}
          <aside className="dg-sidebar-shell hidden min-h-0 overflow-hidden border-r border-[var(--surface-border)] lg:block">
            {settingsModalOpen ? (
              <SettingsSidebar
                tab={settingsModalTab}
                onTabChange={setSettingsModalTab}
                onMobileNavOpenChange={setSettingsMobileNavOpen}
                onClose={closeSettingsWorkspace}
                onRequestReset={() => setResetSettingsDialogOpen(true)}
              />
            ) : (
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
            )}
          </aside>

          {/* Chat section */}
          <section className="relative flex min-h-0 min-w-0 overflow-hidden">
            <FloatingStatusBar
              voiceMode={voiceMode}
              voiceState={voiceState}
              voiceTranscript={voiceTranscript}
              errorItems={visibleErrorItems}
              warnings={visibleWarnings}
              eventToasts={visibleEventToasts}
              updateStatus={updateStatus}
              onDismissUpdate={() => updateChecker.dismiss()}
              onReload={() => window.location.reload()}
            />
            {settingsModalOpen ? (
              <SettingsWorkspace
                tab={settingsModalTab}
                onTabChange={setSettingsModalTab}
                mobileNavOpen={settingsMobileNavOpen}
                onMobileNavOpenChange={setSettingsMobileNavOpen}
                onClose={closeSettingsWorkspace}
                onRequestReset={() => setResetSettingsDialogOpen(true)}
                settingsDraft={settingsDraft}
                setSettingsDraft={setSettingsDraft}
                onDeleteSavedPromptPreset={deleteSavedPromptPreset}
                waveforms={waveforms}
                customWaveforms={customWaveforms}
                onImportWaveforms={(files) => void importWaveformFiles(files)}
                onImportWaveformFromMarket={(waveform) => void importWaveformFromMarket(waveform)}
                onRemoveWaveform={(id) => void removeWaveform(id)}
                onEditWaveform={openWaveformEditor}
                opossum={opossum}
                pawPrints={pawPrints}
                civetEdging={civetEdging}
                sensorTriggersEnabled={sensorTriggersEnabled}
                onToggleSensorTriggers={(enabled) => void toggleSensorTriggers(enabled)}
                bridgeLogs={bridgeLogs}
                bridgeStatus={bridgeStatus}
                modelLogTurns={modelLog.turns}
                onClearModelLogs={modelLog.clear}
                settings={settings}
                exportableSessions={savedSessions.map((s) => ({
                  id: s.id,
                  title: getSessionTitle(s),
                  updatedAt: s.updatedAt,
                }))}
                onExportSessions={(ids) => void exportSessions(ids)}
                onImportSessions={(file) => void importSessions(file)}
              />
            ) : (
              <ChatPanel
                activeSessionId={activeSessionId}
                text={text}
                statusMessage={statusMessage}
                onTextChange={setText}
                onAbortReply={() => void abortCurrentReply()}
                onToggleVoiceMode={() => void toggleVoiceMode()}
                onSend={() => void send()}
                busy={busy}
                speechRecognitionEnabled={settings.speechRecognitionEnabled}
                voiceMode={voiceMode}
                voiceState={voiceState}
                speechRecognitionSupported={speechCapabilities.recognitionSupported}
                session={session}
                traceFeed={traceFeed}
                streamingAssistantText={streamingAssistantText}
                deviceState={deviceState}
                maxStrengthA={settings.maxStrengthA}
                maxStrengthB={settings.maxStrengthB}
                opossumState={opossumState}
                maxOpossumIntensityA={settings.maxOpossumIntensityA}
                maxOpossumIntensityB={settings.maxOpossumIntensityB}
                pawPrintsState={pawPrintsState}
                civetEdgingState={civetEdgingState}
                onConnect={() => void connect()}
                onDisconnectOpossum={() => void disconnectOpossum()}
                onDisconnectPawPrints={() => void disconnectPawPrints()}
                onDisconnectCivetEdging={() => void disconnectCivetEdging()}
                onEmergencyStop={() => void stop()}
                onOpenSidebar={() => setSidebarOpen(true)}
                onOpenSettings={() => openSettingsModal('general')}
                promptPresetId={settings.promptPresetId}
                builtinPresets={BUILTIN_PROMPT_PRESETS.filter(
                  (p) => !settings.hiddenBuiltinPresetIds.includes(p.id),
                )}
                savedPresets={settings.savedPromptPresets}
                onPresetChange={(id) => {
                  setSettingsDraft((prev) => ({ ...prev, promptPresetId: id }));
                  flushSettingsDraft();
                }}
              />
            )}
          </section>
        </section>
      </main>

      {!safetyNoticeAccepted && <SafetyNoticeModal onAccept={handleSafetyNoticeAccept} />}
    </>
  );
}
