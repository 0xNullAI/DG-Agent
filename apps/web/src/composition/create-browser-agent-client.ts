import { createEmbeddedAgentClient, type AgentClient } from '@dg-agent/client';
import type { LlmPort, LlmTurnInput, LlmTurnResult, PermissionPort, SessionStorePort, SessionTraceStorePort, WaveformLibraryPort } from '@dg-agent/contracts';
import { CoyoteProtocolAdapter, getWebBluetoothAvailability, WebBluetoothDevicePort } from '@dg-agent/device-webbluetooth';
import { BrowserPermissionPort } from '@dg-agent/permissions-browser';
import { resolveProviderRuntimeSettings } from '@dg-agent/providers-catalog';
import { OpenAiHttpLlmPort } from '@dg-agent/providers-openai-http';
import { PolicyEngine, createDefaultPolicyRules } from '@dg-agent/runtime';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { createBuildBrowserInstructions } from './build-browser-instructions.js';

class UnavailableLlmPort implements LlmPort {
  constructor(private readonly message: string) {}

  async runTurn(_input: LlmTurnInput): Promise<LlmTurnResult> {
    throw new Error(this.message);
  }
}

export interface CreateBrowserAgentClientOptions {
  settings: BrowserAppSettings;
  sessionStore?: SessionStorePort;
  sessionTraceStore?: SessionTraceStorePort;
  waveformLibrary: WaveformLibraryPort;
  permissionPort?: PermissionPort;
}

export function createBrowserAgentClient(options: CreateBrowserAgentClientOptions): AgentClient {
  const { settings } = options;
  const config = settings;
  const provider = resolveProviderRuntimeSettings(config.provider);

  const device = new WebBluetoothDevicePort({
    protocol: new CoyoteProtocolAdapter(),
  });

  const llm =
    provider.browserSupported && provider.apiKey
      ? new OpenAiHttpLlmPort({
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          model: provider.model,
          endpoint: provider.endpoint,
          useStrict: provider.useStrict,
        })
      : new UnavailableLlmPort(
          provider.browserSupported
            ? '当前模型服务还没有配置完成，请先在设置里选择服务提供方并补全凭证。'
            : `当前服务提供方“${config.provider.providerId}”不支持浏览器直连，请改用可在浏览器运行的服务。`,
        );

  return createEmbeddedAgentClient({
    device,
    llm,
    permission:
      options.permissionPort ??
      new BrowserPermissionPort({
        mode: settings.permissionMode,
      }),
    policyEngine: new PolicyEngine(
      createDefaultPolicyRules({
        maxStrengthA: settings.maxStrengthA,
        maxStrengthB: settings.maxStrengthB,
      }),
    ),
    buildInstructions: createBuildBrowserInstructions({
      promptPresetId: settings.promptPresetId,
      customPrompt: settings.customPrompt,
      savedPromptPresets: settings.savedPromptPresets,
      maxStrengthA: settings.maxStrengthA,
      maxStrengthB: settings.maxStrengthB,
    }),
    sessionStore: options.sessionStore,
    sessionTraceStore: options.sessionTraceStore,
    waveformLibrary: options.waveformLibrary,
  });
}

export function describeBrowserModes(settings: BrowserAppSettings): {
  deviceMode: 'fake' | 'web-bluetooth';
  llmMode: 'fake' | 'provider-http';
  bluetoothAvailability: ReturnType<typeof getWebBluetoothAvailability>;
  permissionMode: BrowserAppSettings['permissionMode'];
  providerId: BrowserAppSettings['provider']['providerId'];
} {
  const config = settings;

  return {
    deviceMode: config.deviceMode,
    llmMode: config.llmMode,
    permissionMode: config.permissionMode,
    providerId: config.provider.providerId,
    bluetoothAvailability: getWebBluetoothAvailability(),
  };
}
