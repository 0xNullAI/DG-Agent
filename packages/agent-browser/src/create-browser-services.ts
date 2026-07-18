import {
  NULL_SPEECH_CAPABILITIES,
  createNullSpeechRecognitionController,
  createNullSpeechSynthesizer,
  createSpeechRecognitionController,
  createSpeechSynthesizer,
  getBrowserSpeechCapabilities,
} from '@dg-agent/audio-browser';
import {
  BridgeAdapterRegistry,
  BridgeManager,
  BridgePermissionService,
  createBrowserBridgeAdapters,
  type MessageOrigin,
} from '@dg-agent/bridge';
import type { AgentClient } from '@dg-agent/client';
import type {
  DeviceClient,
  PermissionDecision,
  RuntimeEvent,
  RuntimeTraceEntry,
  SessionSnapshot,
} from '@dg-agent/core';
import {
  CoyoteProtocolAdapter,
  WebBluetoothCivetEdgingClient,
  WebBluetoothDeviceClient,
  WebBluetoothOpossumClient,
  WebBluetoothPawPrintsClient,
} from '@dg-agent/device-webbluetooth';
import { BrowserPermissionService } from '@dg-agent/permissions-browser';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from '@dg-agent/runtime';
import {
  BrowserSessionStore,
  BrowserSessionTraceStore,
  type BrowserAppSettings,
} from '@dg-agent/storage-browser';
import { BrowserWaveformLibrary } from '@dg-agent/waveforms';
import { createBrowserAgentClient, describeBrowserModes } from './create-browser-agent-client.js';

export interface PermissionRequestInput {
  toolName: string;
  toolDisplayName?: string;
  summary: string;
  args: Record<string, unknown>;
}

export interface BrowserServicesOptions {
  settings: BrowserAppSettings;
  onPermissionRequest: (input: PermissionRequestInput) => Promise<PermissionDecision>;
  resolveBridgeSessionId: (origin: MessageOrigin) => string | null | Promise<string | null>;
  /**
   * A pre-built device client to reuse across settings-driven service rebuilds.
   * When provided, `createDeviceClient` is ignored and no new device is
   * constructed — this keeps the underlying BLE connection alive when other
   * settings (provider, voice, bridge, …) change. Web/Android shells pass a
   * device they own and hold stable across re-renders.
   */
  device?: DeviceClient;
  /**
   * Optional override for the device client. Used by non-browser shells
   * (e.g. the Tauri Android app) to inject a transport that doesn't depend
   * on Web Bluetooth. Only consulted when `device` is not supplied. Defaults
   * to constructing a WebBluetoothDeviceClient.
   */
  createDeviceClient?: (protocol: CoyoteProtocolAdapter) => DeviceClient;
  /**
   * Pre-built auxiliary device clients (opossum, paw-prints, civet-edging),
   * reused across settings-driven service rebuilds the same way `device` is
   * — each defaults to a lazily-constructed `WebBluetoothOpossumClient` /
   * `WebBluetoothPawPrintsClient` / `WebBluetoothCivetEdgingClient` when not
   * supplied. Unlike `device`/`createDeviceClient`, there is no non-browser
   * override hook yet: none of these three kinds have a Tauri/Android
   * transport (see DG-Chat's `DeviceSession` doc comment — Android WebView
   * has no Web Bluetooth), so the shells that need one don't exist yet.
   */
  opossum?: OpossumClient;
  pawPrints?: PawPrintsClient;
  civetEdging?: CivetEdgingClient;
  /**
   * If true, speech recognition / synthesis are stubbed with no-op controllers
   * and capabilities report nothing supported. Used by shells (Android WebView)
   * that lack Web Speech APIs.
   */
  disableSpeech?: boolean;
  /**
   * If true, the BridgeManager is constructed without any adapters, so QQ /
   * Telegram bridges are silently disabled. Used by shells that intentionally
   * ship without bridge integrations.
   */
  disableBridge?: boolean;
  /**
   * Shared secret for HMAC-signing requests to the free-tier proxy.
   * Tauri Android passes this so the proxy will allow its requests
   * (which carry no recognizable browser Origin). Web builds leave it
   * undefined and rely on the proxy's Origin whitelist.
   */
  freeProxySecret?: string;
}

export interface BrowserServices {
  client: AgentClient;
  device: DeviceClient;
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
  bridgeManager: BridgeManager;
  waveformLibrary: BrowserWaveformLibrary;
  speechRecognition: ReturnType<typeof createSpeechRecognitionController>;
  speechSynthesizer: ReturnType<typeof createSpeechSynthesizer>;
  speechCapabilities: ReturnType<typeof getBrowserSpeechCapabilities>;
  modes: ReturnType<typeof describeBrowserModes>;
  resetPermissionGrants: () => void;
  warnings: string[];
}

class UnavailableAgentClient implements AgentClient {
  readonly transport = 'embedded' as const;
  readonly supportsLiveEvents = false;

  constructor(private readonly message: string) {}

  listSessions(): Promise<SessionSnapshot[]> {
    return Promise.resolve([]);
  }

  getSessionSnapshot(_sessionId: string): Promise<SessionSnapshot> {
    return Promise.reject(new Error(this.message));
  }

  getSessionTrace(_sessionId: string): Promise<RuntimeTraceEntry[]> {
    return Promise.resolve([]);
  }

  importSessions(_sessions: SessionSnapshot[]): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  deleteSession(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  connectDevice(_sessionId?: string): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  disconnectDevice(): Promise<void> {
    return Promise.resolve();
  }

  emergencyStop(_sessionId: string): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  abortCurrentReply(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  sendUserMessage(): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  subscribe(_listener: (event: RuntimeEvent) => void): () => void {
    return () => undefined;
  }
}

function formatInitError(prefix: string, error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `${prefix}：${error.message}`;
  }
  return `${prefix}，请检查相关设置`;
}

export function createBrowserServices(options: BrowserServicesOptions): BrowserServices {
  const { settings, onPermissionRequest, resolveBridgeSessionId } = options;

  const warnings: string[] = [];

  const sessionStore = new BrowserSessionStore();
  const sessionTraceStore = new BrowserSessionTraceStore();
  const waveformLibrary = new BrowserWaveformLibrary();
  const bridgeRegistry = new BridgeAdapterRegistry();
  const device =
    options.device ??
    (() => {
      const deviceProtocol = new CoyoteProtocolAdapter();
      return options.createDeviceClient
        ? options.createDeviceClient(deviceProtocol)
        : new WebBluetoothDeviceClient({ protocol: deviceProtocol });
    })();
  const opossum = options.opossum ?? new WebBluetoothOpossumClient();
  const pawPrints = options.pawPrints ?? new WebBluetoothPawPrintsClient();
  const civetEdging = options.civetEdging ?? new WebBluetoothCivetEdgingClient();

  const speechRecognition = options.disableSpeech
    ? createNullSpeechRecognitionController()
    : createSpeechRecognitionController({
        lang: settings.speechRecognitionLanguage,
        mode: settings.voice.mode,
        proxyUrl: settings.voice.proxyUrl,
        apiKey: settings.voice.apiKey,
        autoStopEnabled: settings.voice.autoStopEnabled,
      });
  const speechSynthesizer = options.disableSpeech
    ? createNullSpeechSynthesizer()
    : createSpeechSynthesizer({
        lang: settings.speechSynthesisLanguage,
        mode: settings.voice.mode,
        proxyUrl: settings.voice.proxyUrl,
        apiKey: settings.voice.apiKey,
        speaker: settings.voice.speaker,
        browserVoiceUri: settings.voice.browserVoiceUri,
      });
  const speechCapabilities = options.disableSpeech
    ? NULL_SPEECH_CAPABILITIES
    : getBrowserSpeechCapabilities({
        recognitionMode: settings.voice.mode,
        synthesisMode: settings.voice.mode,
      });

  const localPermissionService = new BrowserPermissionService({
    mode: settings.permissionMode,
    timedGrantExpiresAt: settings.permissionModeExpiresAt,
    requestFn: (input) =>
      onPermissionRequest({
        toolName: input.toolName,
        toolDisplayName: input.toolDisplayName,
        summary: input.summary,
        args: input.args,
      }),
  });
  const bridgePermissionService = new BridgePermissionService({
    settings: settings.bridge,
    fallback: localPermissionService,
    registry: bridgeRegistry,
  });

  let client: AgentClient;
  try {
    client = createBrowserAgentClient({
      settings,
      device,
      opossum,
      pawPrints,
      civetEdging,
      sessionStore,
      sessionTraceStore,
      waveformLibrary,
      permissionService: bridgePermissionService,
      freeProxySecret: options.freeProxySecret,
    });
  } catch (error) {
    const message = formatInitError('模型服务初始化失败', error);
    warnings.push(message);
    client = new UnavailableAgentClient(message);
  }

  let bridgeManager: BridgeManager;
  if (options.disableBridge) {
    bridgeManager = new BridgeManager({
      client,
      registry: bridgeRegistry,
      adapters: [],
      resolveTargetSessionId: resolveBridgeSessionId,
    });
  } else {
    try {
      bridgeManager = new BridgeManager({
        client,
        registry: bridgeRegistry,
        adapters: createBrowserBridgeAdapters(settings.bridge),
        resolveTargetSessionId: resolveBridgeSessionId,
      });
    } catch (error) {
      warnings.push(formatInitError('桥接服务初始化失败', error));
      bridgeManager = new BridgeManager({
        client,
        registry: bridgeRegistry,
        adapters: [],
        resolveTargetSessionId: resolveBridgeSessionId,
      });
    }
  }

  return {
    client,
    device,
    opossum,
    pawPrints,
    civetEdging,
    bridgeManager,
    waveformLibrary,
    speechRecognition,
    speechSynthesizer,
    speechCapabilities,
    modes: describeBrowserModes(settings, {
      bluetoothAvailabilityOverride: options.createDeviceClient ? { supported: true } : undefined,
    }),
    resetPermissionGrants: () => bridgePermissionService.clearGrants(),
    warnings,
  };
}
