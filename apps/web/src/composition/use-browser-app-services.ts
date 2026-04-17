import { useMemo, type Dispatch, type SetStateAction } from 'react';
import {
  createSpeechRecognitionController,
  createSpeechSynthesizer,
  getBrowserSpeechCapabilities,
} from '@dg-agent/audio-browser';
import { createBrowserBridgeAdapters } from '@dg-agent/bridge-browser';
import { BridgeAdapterRegistry, BridgeManager, BridgePermissionPort } from '@dg-agent/bridge-core';
import type { PermissionDecision } from '@dg-agent/core';
import { BrowserPermissionPort } from '@dg-agent/permissions-browser';
import { BrowserSessionStore, BrowserSessionTraceStore, type BrowserAppSettings } from '@dg-agent/storage-browser';
import { BrowserUpdateChecker } from '@dg-agent/update-browser';
import { BrowserWaveformLibrary } from '@dg-agent/waveforms-browser';
import { createBrowserAgentClient, describeBrowserModes } from './create-browser-agent-client.js';

export interface PendingPermissionRequest {
  input: {
    toolName: string;
    toolDisplayName?: string;
    summary: string;
    args: Record<string, unknown>;
  };
  resolve: (decision: PermissionDecision) => void;
}

export interface UseBrowserAppServicesOptions {
  settings: BrowserAppSettings;
  setPendingPermission: Dispatch<SetStateAction<PendingPermissionRequest | null>>;
}

export function useBrowserAppServices(options: UseBrowserAppServicesOptions) {
  const { settings, setPendingPermission } = options;

  const sessionStore = useMemo(() => new BrowserSessionStore(), []);
  const sessionTraceStore = useMemo(() => new BrowserSessionTraceStore(), []);
  const waveformLibrary = useMemo(() => new BrowserWaveformLibrary(), []);
  const bridgeRegistry = useMemo(() => new BridgeAdapterRegistry(), []);
  const updateChecker = useMemo(
    () =>
      new BrowserUpdateChecker({
        currentBuildId: __BUILD_ID__,
        versionUrl: `${import.meta.env.BASE_URL}version.json`,
      }),
    [],
  );

  const speechRecognition = useMemo(
    () =>
      createSpeechRecognitionController({
        lang: settings.voiceLanguage,
        mode: settings.voice.mode,
        proxyUrl: settings.voice.proxyUrl,
        apiKey: settings.voice.apiKey,
        autoStopEnabled: settings.voice.autoStopEnabled,
      }),
    [settings.voice.apiKey, settings.voice.autoStopEnabled, settings.voice.mode, settings.voice.proxyUrl, settings.voiceLanguage],
  );
  const speechSynthesizer = useMemo(
    () =>
      createSpeechSynthesizer({
        lang: settings.voiceLanguage,
        mode: settings.voice.mode,
        proxyUrl: settings.voice.proxyUrl,
        apiKey: settings.voice.apiKey,
        speaker: settings.voice.speaker,
      }),
    [settings.voice.apiKey, settings.voice.mode, settings.voice.proxyUrl, settings.voice.speaker, settings.voiceLanguage],
  );
  const speechCapabilities = useMemo(
    () =>
      getBrowserSpeechCapabilities({
        recognitionMode: settings.voice.mode,
        synthesisMode: settings.voice.mode,
      }),
    [settings.voice.mode],
  );

  const localPermissionPort = useMemo(
    () =>
      new BrowserPermissionPort({
        mode: settings.permissionMode,
        timedGrantExpiresAt: settings.permissionModeExpiresAt,
        requestFn: (input) =>
          new Promise<PermissionDecision>((resolve) => {
            setPendingPermission({
              input: {
                toolName: input.toolName,
                toolDisplayName: input.toolDisplayName,
                summary: input.summary,
                args: input.args,
              },
              resolve,
            });
          }),
      }),
    [settings.permissionMode, settings.permissionModeExpiresAt, setPendingPermission],
  );
  const bridgePermissionPort = useMemo(
    () =>
      new BridgePermissionPort({
        settings: settings.bridge,
        fallback: localPermissionPort,
        registry: bridgeRegistry,
      }),
    [bridgeRegistry, localPermissionPort, settings.bridge],
  );
  const client = useMemo(
    () =>
      createBrowserAgentClient({
        settings,
        sessionStore,
        sessionTraceStore,
        waveformLibrary,
        permissionPort: bridgePermissionPort,
      }),
    [bridgePermissionPort, sessionStore, sessionTraceStore, settings, waveformLibrary],
  );
  const modes = useMemo(() => describeBrowserModes(settings), [settings]);
  const bridgeManager = useMemo(
    () =>
      new BridgeManager({
        client,
        registry: bridgeRegistry,
        adapters: createBrowserBridgeAdapters(settings.bridge),
      }),
    [bridgeRegistry, client, settings.bridge],
  );

  const resetPermissionGrants = useMemo(
    () => () => {
      bridgePermissionPort.clearGrants();
    },
    [bridgePermissionPort],
  );

  return {
    waveformLibrary,
    updateChecker,
    speechRecognition,
    speechSynthesizer,
    speechCapabilities,
    client,
    modes,
    bridgeManager,
    resetPermissionGrants,
  };
}
