import type { getBrowserSpeechCapabilities } from '@dg-agent/audio-browser';
import { isProviderUsableInBrowser, providerRequiresUserApiKey } from '@dg-agent/providers-catalog';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import type { describeBrowserModes } from '@dg-agent/agent-browser';

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface BuildWarningsOptions {
  /** Suppress QQ/Telegram bridge config warnings (Tauri shell ships without bridges). */
  suppressBridge?: boolean;
  /** Suppress speech recognition/synthesis warnings (Tauri shell ships without speech). */
  suppressSpeech?: boolean;
}

export function buildWarnings(
  settings: BrowserAppSettings,
  modes: ReturnType<typeof describeBrowserModes>,
  speechCapabilities: ReturnType<typeof getBrowserSpeechCapabilities>,
  options: BuildWarningsOptions = {},
): string[] {
  const warnings: string[] = [];

  if (settings.deviceMode === 'web-bluetooth' && !modes.bluetoothAvailability.supported) {
    warnings.push(modes.bluetoothAvailability.reason ?? '当前浏览器不支持 Web Bluetooth');
  }

  if (
    settings.llmMode === 'provider-http' &&
    providerRequiresUserApiKey(settings.provider) &&
    !settings.provider.apiKey.trim()
  ) {
    warnings.push('当前已启用模型服务，但还没有配置 API Key');
  }

  if (settings.llmMode === 'provider-http' && !isProviderUsableInBrowser(settings.provider)) {
    warnings.push(`当前服务提供方「${settings.provider.providerId}」不支持浏览器直连`);
  }

  if (
    settings.llmMode === 'provider-http' &&
    isProviderUsableInBrowser(settings.provider) &&
    settings.provider.apiKey.trim() &&
    !isValidHttpUrl(settings.provider.baseUrl)
  ) {
    warnings.push('当前模型接口地址无效，请在设置里检查接口地址');
  }

  if (
    !settings.rememberApiKey &&
    ((settings.llmMode === 'provider-http' &&
      providerRequiresUserApiKey(settings.provider) &&
      settings.provider.apiKey.trim()) ||
      (settings.voice.mode === 'dashscope-proxy' && settings.voice.apiKey.trim()))
  ) {
    warnings.push('当前 API Key 只会保留在当前页面运行期间；刷新或关闭页面后会丢失');
  }

  if (settings.maxStrengthA > 100 || settings.maxStrengthB > 100) {
    warnings.push('A 或 B 通道的强度上限超过了 100，请再次确认安全阈值');
  }

  if (
    !options.suppressBridge &&
    settings.bridge.enabled &&
    settings.bridge.qq.enabled &&
    !settings.bridge.qq.wsUrl.trim()
  ) {
    warnings.push('已启用 QQ 桥接，但 QQ WebSocket 地址为空');
  }

  if (
    settings.bridge.enabled &&
    settings.bridge.qq.enabled &&
    settings.bridge.qq.allowUsers.length === 0 &&
    settings.bridge.qq.allowGroups.length === 0
  ) {
    warnings.push('已启用 QQ 桥接，但还没有配置允许的用户或群组');
  }

  if (
    settings.bridge.enabled &&
    settings.bridge.telegram.enabled &&
    !settings.bridge.telegram.botToken.trim()
  ) {
    warnings.push('已启用 Telegram 桥接，但 Bot Token 为空');
  }

  if (
    settings.bridge.enabled &&
    settings.bridge.telegram.enabled &&
    settings.bridge.telegram.allowUsers.length === 0
  ) {
    warnings.push('已启用 Telegram 桥接，但还没有配置允许的用户');
  }

  if (
    !options.suppressSpeech &&
    settings.speechRecognitionEnabled &&
    !speechCapabilities.recognitionSupported
  ) {
    warnings.push(
      settings.voice.mode === 'dashscope-proxy'
        ? '已启用语音识别，但当前浏览器无法使用 DashScope 代理识别链路'
        : '已启用语音识别，但当前浏览器不支持语音识别',
    );
  }

  if (
    !options.suppressSpeech &&
    settings.speechSynthesisEnabled &&
    !speechCapabilities.synthesisSupported
  ) {
    warnings.push(
      settings.voice.mode === 'dashscope-proxy'
        ? '已启用语音合成，但当前浏览器无法使用 DashScope 代理合成链路'
        : '已启用语音合成，但当前浏览器不支持语音合成',
    );
  }

  if (
    !options.suppressSpeech &&
    settings.voice.mode === 'dashscope-proxy' &&
    settings.voice.proxyUrl.trim() &&
    !settings.voice.apiKey.trim()
  ) {
    warnings.push(
      '已设置自定义语音服务代理地址，但没有填写 DashScope API Key；请确认代理会自行注入鉴权',
    );
  }

  return warnings;
}
