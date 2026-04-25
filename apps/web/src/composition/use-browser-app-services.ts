import { useMemo, type Dispatch, type SetStateAction } from 'react';
import {
  createSpeechRecognitionController,
  createSpeechSynthesizer,
  getBrowserSpeechCapabilities,
} from '@dg-agent/audio-browser';
import { createBrowserBridgeAdapters } from '@dg-agent/bridge-browser';
import {
  BridgeAdapterRegistry,
  BridgeManager,
  BridgePermissionService,
  type MessageOrigin,
} from '@dg-agent/bridge-core';
import { CoyoteProtocolAdapter, WebBluetoothDeviceClient } from '@dg-agent/device-webbluetooth';
import type { PermissionDecision } from '@dg-agent/core';
import { BrowserPermissionService } from '@dg-agent/permissions-browser';
import {
  BrowserSessionStore,
  BrowserSessionTraceStore,
  type BrowserAppSettings,
} from '@dg-agent/storage-browser';
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
  resolveBridgeSessionId: (origin: MessageOrigin) => string | null | Promise<string | null>;
}

export function useBrowserAppServices(options: UseBrowserAppServicesOptions) {
  const { resolveBridgeSessionId, settings, setPendingPermission } = options;

  const sessionStore = useMemo(() => new BrowserSessionStore(), []);
  const sessionTraceStore = useMemo(() => new BrowserSessionTraceStore(), []);
  const waveformLibrary = useMemo(() => new BrowserWaveformLibrary(), []);
  const bridgeRegistry = useMemo(() => new BridgeAdapterRegistry(), []);
  const deviceProtocol = useMemo(() => new CoyoteProtocolAdapter(), []);
  const device = useMemo(
    () =>
      new WebBluetoothDeviceClient({
        protocol: deviceProtocol,
      }),
    [deviceProtocol],
  );
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
        lang: settings.speechRecognitionLanguage,
        mode: settings.voice.mode,
        proxyUrl: settings.voice.proxyUrl,
        apiKey: settings.voice.apiKey,
        autoStopEnabled: settings.voice.autoStopEnabled,
      }),
    [
      settings.voice.apiKey,
      settings.voice.autoStopEnabled,
      settings.voice.mode,
      settings.voice.proxyUrl,
      settings.speechRecognitionLanguage,
    ],
  );
  const speechSynthesizer = useMemo(
    () =>
      createSpeechSynthesizer({
        lang: settings.speechSynthesisLanguage,
        mode: settings.voice.mode,
        proxyUrl: settings.voice.proxyUrl,
        apiKey: settings.voice.apiKey,
        speaker: settings.voice.speaker,
        browserVoiceUri: settings.voice.browserVoiceUri,
      }),
    [
      settings.voice.apiKey,
      settings.voice.browserVoiceUri,
      settings.voice.mode,
      settings.voice.proxyUrl,
      settings.voice.speaker,
      settings.speechSynthesisLanguage,
    ],
  );
  const speechCapabilities = useMemo(
    () =>
      getBrowserSpeechCapabilities({
        recognitionMode: settings.voice.mode,
        synthesisMode: settings.voice.mode,
      }),
    [settings.voice.mode],
  );

  const localPermissionService = useMemo(
    () =>
      new BrowserPermissionService({
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
  const bridgePermissionService = useMemo(
    () =>
      new BridgePermissionService({
        settings: settings.bridge,
        fallback: localPermissionService,
        registry: bridgeRegistry,
      }),
    [bridgeRegistry, localPermissionService, settings.bridge],
  );
  const client = useMemo(
    () =>
      createBrowserAgentClient({
        settings,
        device,
        sessionStore,
        sessionTraceStore,
        waveformLibrary,
        permissionService: bridgePermissionService,
      }),
    [bridgePermissionService, device, sessionStore, sessionTraceStore, settings, waveformLibrary],
  );
  const modes = useMemo(() => describeBrowserModes(settings), [settings]);
  const bridgeManager = useMemo(
    () =>
      new BridgeManager({
        client,
        registry: bridgeRegistry,
        adapters: createBrowserBridgeAdapters(settings.bridge),
        resolveTargetSessionId: resolveBridgeSessionId,
      }),
    [bridgeRegistry, client, resolveBridgeSessionId, settings.bridge],
  );

  const resetPermissionGrants = useMemo(
    () => () => {
      bridgePermissionService.clearGrants();
    },
    [bridgePermissionService],
  );

  return {
    waveformLibrary,
    device,
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
