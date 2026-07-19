import { createEmbeddedAgentClient, type AgentClient } from '@dg-agent/client';
import type {
  DeviceClient,
  LlmClient,
  LlmTurnInput,
  LlmTurnResult,
  PermissionService,
  SessionStore,
  SessionTraceStore,
  WaveformLibrary,
} from '@dg-agent/core';
import { getWebBluetoothAvailability } from '@dg-agent/device-webbluetooth';
import { BrowserPermissionService } from '@dg-agent/permissions-browser';
import {
  createFreeProxyHmacHeaders,
  resolveProviderRuntimeSettings,
  type ProviderDialect,
} from '@dg-agent/providers-catalog';
import { OpenAiHttpLlmClient } from '@dg-agent/providers-openai-http';
import {
  PI_AI_PROVIDER_KEYS,
  PiAiLlmClient,
  type PiAiProviderKey,
} from '@dg-agent/providers-pi-http';
import {
  OpossumPolicyEngine,
  PolicyEngine,
  createDefaultOpossumPolicyRules,
  createDefaultPolicyRules,
  createDefaultToolRegistryWithDeps,
  type CivetEdgingClient,
  type OpossumClient,
  type PawPrintsClient,
} from '@dg-agent/runtime';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { createBuildBrowserInstructions } from './build-browser-instructions.js';

class UnavailableLlmClient implements LlmClient {
  constructor(private readonly message: string) {}

  async runTurn(_input: LlmTurnInput): Promise<LlmTurnResult> {
    throw new Error(this.message);
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * providers-catalog's `ProviderDefinition.piProviderKey` is deliberately
 * typed as a loose `string` (so providers-catalog doesn't have to depend on
 * providers-pi-http just for a literal union) — this is the one place that
 * gap gets closed, against providers-pi-http's actual known loader keys, so a
 * catalog/registry drift (typo, rename, a catalog entry added without a
 * matching loader) shows a friendly Chinese message here instead of
 * constructing successfully and only failing later, deep inside a chat
 * turn's `runTurn()`.
 */
export function isPiAiProviderKey(value: string): value is PiAiProviderKey {
  return (PI_AI_PROVIDER_KEYS as readonly string[]).includes(value);
}

/**
 * Both `OpenAiHttpLlmClient` and `PiAiLlmClient` validate their config with
 * zod and throw a `ZodError` on a bad shape; this turns that into a Chinese
 * message for the settings UI. The two clients' `configSchema`s have
 * different fields (`baseUrl` only exists for the openai-compat one,
 * `providerKey` only for the pi-ai one), so which pattern is worth checking
 * for depends on which dialect actually threw — without branching on
 * `dialect`, a pi-ai config error would never match the openai-compat-only
 * `/baseUrl/i` check and fall straight through to the generic branch, which
 * dumps the raw (English/JSON-shaped) ZodError text into the otherwise
 * all-Chinese settings UI.
 */
export function formatProviderConfigError(
  error: unknown,
  providerId: string,
  dialect: ProviderDialect,
): string {
  const providerLabel = `当前服务提供方“${providerId}”`;

  if (dialect === 'openai-compat' && error instanceof Error && /baseUrl/i.test(error.message)) {
    return `${providerLabel}配置无效：接口地址不是有效的 URL`;
  }

  if (dialect === 'pi-ai' && error instanceof Error && /providerKey/i.test(error.message)) {
    return `${providerLabel}配置无效：内部提供方标识不受支持，请重新选择服务提供方或联系开发者`;
  }

  if (dialect === 'pi-ai' && error instanceof Error) {
    return `${providerLabel}配置无效：请检查 API 密钥与模型名称是否填写正确`;
  }

  if (error instanceof Error) {
    return `${providerLabel}配置无效：${error.message}`;
  }

  return `${providerLabel}配置无效，请在设置里检查模型参数`;
}

export interface CreateBrowserAgentClientOptions {
  settings: BrowserAppSettings;
  device: DeviceClient;
  /** At most one connected auxiliary device of each kind, alongside Coyote. */
  opossum?: OpossumClient;
  pawPrints?: PawPrintsClient;
  civetEdging?: CivetEdgingClient;
  sessionStore?: SessionStore;
  sessionTraceStore?: SessionTraceStore;
  waveformLibrary: WaveformLibrary;
  permissionService?: PermissionService;
  /**
   * Shared secret used to sign requests to the free-tier proxy. Only the
   * Tauri Android shell supplies this (via a build-time env var); web
   * builds rely on the proxy's Origin whitelist instead. Ignored unless
   * the active provider is `free`.
   */
  freeProxySecret?: string;
}

export function createBrowserAgentClient(options: CreateBrowserAgentClientOptions): AgentClient {
  const { settings } = options;
  const config = settings;
  const provider = resolveProviderRuntimeSettings(config.provider);

  let llm: LlmClient;
  if (!provider.browserSupported) {
    llm = new UnavailableLlmClient(
      `当前服务提供方“${config.provider.providerId}”不支持浏览器直连，请改用可在浏览器运行的服务`,
    );
  } else if (!provider.apiKey) {
    llm = new UnavailableLlmClient(
      '当前模型服务还没有配置完成，请先在设置里选择服务提供方并补全凭证',
    );
  } else if (provider.dialect === 'pi-ai') {
    // Native/pi-ai-routed providers (Anthropic, Google, and the OpenAI-/
    // Anthropic-compatible providers in providers-pi-http's registry) have no
    // baseUrl/endpoint concept — providers-catalog already clears those
    // fields for this dialect (see normalizeProviderSettings), so there is
    // no isValidHttpUrl() check to run here, unlike the openai-compat path
    // below.
    if (!provider.piProviderKey || !isPiAiProviderKey(provider.piProviderKey)) {
      llm = new UnavailableLlmClient(
        `当前服务提供方“${config.provider.providerId}”配置无效：内部提供方标识不受支持，请重新选择服务提供方或联系开发者`,
      );
    } else {
      try {
        llm = new PiAiLlmClient({
          apiKey: provider.apiKey,
          model: provider.model,
          providerKey: provider.piProviderKey,
          temperature: settings.temperature,
        });
      } catch (error) {
        llm = new UnavailableLlmClient(
          formatProviderConfigError(error, config.provider.providerId, provider.dialect),
        );
      }
    }
  } else if (!isValidHttpUrl(provider.baseUrl)) {
    llm = new UnavailableLlmClient(
      `当前服务提供方“${config.provider.providerId}”配置无效：接口地址不是有效的 URL`,
    );
  } else {
    try {
      const extraHeaders =
        provider.providerId === 'free' && options.freeProxySecret
          ? createFreeProxyHmacHeaders(options.freeProxySecret)
          : undefined;
      llm = new OpenAiHttpLlmClient({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        endpoint: provider.endpoint,
        useStrict: provider.useStrict,
        temperature: settings.temperature,
        extraHeaders,
      });
    } catch (error) {
      llm = new UnavailableLlmClient(
        formatProviderConfigError(error, config.provider.providerId, provider.dialect),
      );
    }
  }

  return createEmbeddedAgentClient({
    device: options.device,
    opossum: options.opossum,
    pawPrints: options.pawPrints,
    civetEdging: options.civetEdging,
    llm,
    toolRegistry: createDefaultToolRegistryWithDeps({
      waveformLibrary: options.waveformLibrary,
      toolDefinitionHints: {
        maxColdStartStrength: settings.maxColdStartStrength,
        maxAdjustStrengthStep: settings.maxAdjustStrengthStep,
        maxAdjustStrengthCallsPerTurn: settings.maxAdjustStrengthCallsPerTurn,
        maxBurstDurationMs: settings.maxBurstDurationMs,
        maxBurstCallsPerTurn: settings.maxBurstCallsPerTurn,
        maxVibrateStartIntensity: settings.maxOpossumColdStartIntensity,
        maxVibrateAdjustStep: settings.maxOpossumAdjustStep,
        maxVibrateAdjustCallsPerTurn: settings.maxVibrateAdjustCallsPerTurn,
      },
    }),
    permission:
      options.permissionService ??
      new BrowserPermissionService({
        mode: settings.permissionMode,
      }),
    policyEngine: new PolicyEngine(
      createDefaultPolicyRules({
        maxStrengthA: settings.maxStrengthA,
        maxStrengthB: settings.maxStrengthB,
        maxColdStartStrength: settings.maxColdStartStrength,
        maxAdjustStep: settings.maxAdjustStrengthStep,
        maxBurstDurationMs: settings.maxBurstDurationMs,
        maxBurstStrengthAbsolute: settings.maxBurstStrengthAbsolute,
        maxBurstStrengthRelative: settings.maxBurstStrengthRelative,
      }),
    ),
    opossumPolicyEngine: new OpossumPolicyEngine(
      createDefaultOpossumPolicyRules({
        maxIntensityA: settings.maxOpossumIntensityA,
        maxIntensityB: settings.maxOpossumIntensityB,
        maxColdStartIntensity: settings.maxOpossumColdStartIntensity,
        maxAdjustStep: settings.maxOpossumAdjustStep,
      }),
    ),
    buildInstructions: createBuildBrowserInstructions({
      promptPresetId: settings.promptPresetId,
      savedPromptPresets: settings.savedPromptPresets,
      maxStrengthA: settings.maxStrengthA,
      maxStrengthB: settings.maxStrengthB,
      maxOpossumIntensityA: settings.maxOpossumIntensityA,
      maxOpossumIntensityB: settings.maxOpossumIntensityB,
    }),
    toolCallConfig: {
      maxToolIterations: settings.maxToolIterations,
      maxToolCallsPerTurn: settings.maxToolCallsPerTurn,
      maxAdjustStrengthCallsPerTurn: settings.maxAdjustStrengthCallsPerTurn,
      maxBurstCallsPerTurn: settings.maxBurstCallsPerTurn,
      burstRequiresActiveChannel: settings.burstRequiresActiveChannel,
      maxVibrateAdjustCallsPerTurn: settings.maxVibrateAdjustCallsPerTurn,
    },
    modelContextStrategy: settings.modelContextStrategy,
    sessionStore: options.sessionStore,
    sessionTraceStore: options.sessionTraceStore,
    waveformLibrary: options.waveformLibrary,
  });
}

export function describeBrowserModes(
  settings: BrowserAppSettings,
  options: {
    /**
     * Override the bluetoothAvailability probe. Non-browser shells (Tauri
     * Android) supply their own device transport and want the UI to skip the
     * "Web Bluetooth not supported" warning.
     */
    bluetoothAvailabilityOverride?: ReturnType<typeof getWebBluetoothAvailability>;
  } = {},
): {
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
    bluetoothAvailability: options.bluetoothAvailabilityOverride ?? getWebBluetoothAvailability(),
  };
}
