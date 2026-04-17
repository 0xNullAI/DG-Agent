import { getBrowserSpeechCapabilities } from '@dg-agent/audio-browser';
import { isProviderUsableInBrowser, providerRequiresUserApiKey } from '@dg-agent/providers-catalog';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { describeBrowserModes } from '../composition/create-browser-agent-client.js';

export function buildWarnings(
  settings: BrowserAppSettings,
  modes: ReturnType<typeof describeBrowserModes>,
  speechCapabilities: ReturnType<typeof getBrowserSpeechCapabilities>,
): string[] {
  const warnings: string[] = [];

  if (settings.deviceMode === 'web-bluetooth' && !modes.bluetoothAvailability.supported) {
    warnings.push(modes.bluetoothAvailability.reason ?? '当前浏览器不支持 Web Bluetooth。');
  }

  if (settings.llmMode === 'provider-http' && providerRequiresUserApiKey(settings.provider) && !settings.provider.apiKey.trim()) {
    warnings.push('当前已启用模型服务，但还没有配置 API Key。');
  }

  if (settings.llmMode === 'provider-http' && !isProviderUsableInBrowser(settings.provider)) {
    warnings.push(`当前服务提供方「${settings.provider.providerId}」不支持浏览器直连。`);
  }

  if (
    !settings.rememberApiKey &&
    ((settings.llmMode === 'provider-http' &&
      providerRequiresUserApiKey(settings.provider) &&
      settings.provider.apiKey.trim()) ||
      (settings.voice.mode === 'dashscope-proxy' && settings.voice.apiKey.trim()))
  ) {
    warnings.push('当前 API Key 只会保留到本次浏览器会话结束；如需持久保存，请开启“记住 API Key”。');
  }

  if (settings.maxStrengthA > 100 || settings.maxStrengthB > 100) {
    warnings.push('A 或 B 通道的强度上限超过了 100，请再次确认安全阈值。');
  }

  if (settings.bridge.enabled && settings.bridge.qq.enabled && !settings.bridge.qq.wsUrl.trim()) {
    warnings.push('已启用 QQ 桥接，但 QQ WebSocket 地址为空。');
  }

  if (
    settings.bridge.enabled &&
    settings.bridge.qq.enabled &&
    settings.bridge.qq.allowUsers.length === 0 &&
    settings.bridge.qq.allowGroups.length === 0
  ) {
    warnings.push('已启用 QQ 桥接，但还没有配置允许的用户或群组。');
  }

  if (settings.bridge.enabled && settings.bridge.telegram.enabled && !settings.bridge.telegram.botToken.trim()) {
    warnings.push('已启用 Telegram 桥接，但 Bot Token 为空。');
  }

  if (
    settings.bridge.enabled &&
    settings.bridge.telegram.enabled &&
    settings.bridge.telegram.allowUsers.length === 0
  ) {
    warnings.push('已启用 Telegram 桥接，但还没有配置允许的用户。');
  }

  if (settings.voiceInputEnabled && !speechCapabilities.recognitionSupported) {
    warnings.push(
      settings.voice.mode === 'dashscope-proxy'
        ? '已启用语音输入，但当前浏览器无法使用 DashScope 代理识别链路。'
        : '已启用语音输入，但当前浏览器不支持语音识别。',
    );
  }

  if (settings.ttsEnabled && !speechCapabilities.synthesisSupported) {
    warnings.push(
      settings.voice.mode === 'dashscope-proxy'
        ? '已启用 TTS，但当前浏览器无法使用 DashScope 代理播报链路。'
        : '已启用 TTS，但当前浏览器不支持语音播报。',
    );
  }

  if (settings.voice.mode === 'dashscope-proxy' && settings.voice.proxyUrl.trim() && !settings.voice.apiKey.trim()) {
    warnings.push('已设置自定义语音代理地址，但没有填写 DashScope API Key；请确认代理会自行注入鉴权。');
  }

  return warnings;
}
