import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { PROXY_TTS_SPEAKERS, getBrowserSpeechSynthesisVoices } from '@dg-agent/audio-browser';
import { Input } from '@/components/ui/input';

import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { SettingLabel } from './SettingLabel.js';
import { SettingSelect } from './SettingSelect.js';
import { SettingSegmented } from './SettingSegmented.js';
import { SettingToggle } from './SettingToggle.js';

const VOICE_LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '中文（普通话）' },
  { value: 'zh-HK', label: '中文（粤语 / 香港）' },
  { value: 'zh-TW', label: '中文（台湾）' },
  { value: 'en-US', label: '英语（美国）' },
  { value: 'en-GB', label: '英语（英国）' },
  { value: 'ja-JP', label: '日语' },
  { value: 'ko-KR', label: '韩语' },
];

interface VoiceTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
}

const BROWSER_DEFAULT_VOICE_VALUE = '__browser_default_voice__';

function matchesSpeechLanguage(voiceLang: string, targetLang: string): boolean {
  const normalizedVoiceLang = voiceLang.trim().toLowerCase();
  const normalizedTargetLang = targetLang.trim().toLowerCase();
  if (normalizedVoiceLang === normalizedTargetLang) return true;

  const voiceBase = normalizedVoiceLang.split('-')[0] ?? normalizedVoiceLang;
  const targetBase = normalizedTargetLang.split('-')[0] ?? normalizedTargetLang;
  return Boolean(voiceBase && targetBase && voiceBase === targetBase);
}

export function VoiceTab({ settingsDraft, setSettingsDraft }: VoiceTabProps) {
  const [browserSpeechVoices, setBrowserSpeechVoices] = useState(() =>
    getBrowserSpeechSynthesisVoices(),
  );

  useEffect(() => {
    const updateBrowserSpeechVoices = () => {
      setBrowserSpeechVoices(getBrowserSpeechSynthesisVoices());
    };

    updateBrowserSpeechVoices();
    if (typeof speechSynthesis === 'undefined') return;

    speechSynthesis.addEventListener('voiceschanged', updateBrowserSpeechVoices);
    return () => {
      speechSynthesis.removeEventListener('voiceschanged', updateBrowserSpeechVoices);
    };
  }, []);

  const speechRecognitionLanguageOptions = VOICE_LANGUAGE_OPTIONS.some(
    (option) => option.value === settingsDraft.speechRecognitionLanguage,
  )
    ? VOICE_LANGUAGE_OPTIONS
    : [
        ...VOICE_LANGUAGE_OPTIONS,
        {
          value: settingsDraft.speechRecognitionLanguage,
          label: `当前：${settingsDraft.speechRecognitionLanguage}`,
        },
      ];
  const speechSynthesisLanguageOptions = VOICE_LANGUAGE_OPTIONS.some(
    (option) => option.value === settingsDraft.speechSynthesisLanguage,
  )
    ? VOICE_LANGUAGE_OPTIONS
    : [
        ...VOICE_LANGUAGE_OPTIONS,
        {
          value: settingsDraft.speechSynthesisLanguage,
          label: `当前：${settingsDraft.speechSynthesisLanguage}`,
        },
      ];
  const browserVoiceOptions = useMemo(() => {
    const filteredVoices = browserSpeechVoices.filter((voice) =>
      matchesSpeechLanguage(voice.lang, settingsDraft.speechSynthesisLanguage),
    );
    const options = [
      { value: BROWSER_DEFAULT_VOICE_VALUE, label: '跟随浏览器默认声音' },
      ...filteredVoices.map((voice) => ({
        value: voice.voiceURI,
        label: [
          voice.name,
          voice.lang,
          voice.localService ? '本地' : '在线',
          voice.default ? '默认' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    ];

    const currentVoiceUri = settingsDraft.voice.browserVoiceUri.trim();
    if (currentVoiceUri && !options.some((option) => option.value === currentVoiceUri)) {
      options.push({
        value: currentVoiceUri,
        label: `当前已选：${currentVoiceUri}`,
      });
    }

    return options;
  }, [
    browserSpeechVoices,
    settingsDraft.speechSynthesisLanguage,
    settingsDraft.voice.browserVoiceUri,
  ]);

  function updateVoiceSettings<K extends keyof BrowserAppSettings['voice']>(
    key: K,
    value: BrowserAppSettings['voice'][K],
  ): void {
    setSettingsDraft((current) => ({
      ...current,
      voice: {
        ...current.voice,
        [key]: value,
      },
    }));
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">语音</h3>

        <SettingToggle
          label="启用语音识别"
          checked={settingsDraft.speechRecognitionEnabled}
          onCheckedChange={(checked) =>
            setSettingsDraft((current) => ({
              ...current,
              speechRecognitionEnabled: checked,
            }))
          }
        />

        <SettingToggle
          label="启用语音合成回复"
          checked={settingsDraft.speechSynthesisEnabled}
          onCheckedChange={(checked) =>
            setSettingsDraft((current) => ({
              ...current,
              speechSynthesisEnabled: checked,
            }))
          }
        />

        <SettingSegmented
          label="语音识别 / 合成后端"
          value={settingsDraft.voice.mode}
          onValueChange={(value) =>
            updateVoiceSettings('mode', value as BrowserAppSettings['voice']['mode'])
          }
          options={[
            { value: 'browser', label: '浏览器原生' },
            { value: 'dashscope-proxy', label: 'DashScope 代理' },
          ]}
        />

        {settingsDraft.voice.mode === 'dashscope-proxy' && (
          <div className="provider-hint">
            兼容旧版语音识别 / 合成链路：浏览器采集麦克风，经过 WebSocket
            代理完成语音识别和语音合成，留空代理地址时使用内置免费代理
          </div>
        )}

        <label className="settings-inline-field">
          <SettingLabel>语音识别语言</SettingLabel>
          <SettingSelect
            value={settingsDraft.speechRecognitionLanguage}
            onValueChange={(value) =>
              setSettingsDraft((current) => ({
                ...current,
                speechRecognitionLanguage: value,
              }))
            }
            options={speechRecognitionLanguageOptions}
          />
        </label>

        <label className="settings-inline-field">
          <SettingLabel>语音合成语言</SettingLabel>
          <SettingSelect
            value={settingsDraft.speechSynthesisLanguage}
            onValueChange={(value) =>
              setSettingsDraft((current) => ({
                ...current,
                speechSynthesisLanguage: value,
                voice: {
                  ...current.voice,
                  browserVoiceUri: '',
                },
              }))
            }
            options={speechSynthesisLanguageOptions}
          />
        </label>

        {settingsDraft.voice.mode === 'browser' && (
          <>
            <label className="settings-inline-field">
              <SettingLabel>浏览器语音</SettingLabel>
              <SettingSelect
                value={settingsDraft.voice.browserVoiceUri || BROWSER_DEFAULT_VOICE_VALUE}
                onValueChange={(value) =>
                  updateVoiceSettings(
                    'browserVoiceUri',
                    value === BROWSER_DEFAULT_VOICE_VALUE ? '' : value,
                  )
                }
                options={browserVoiceOptions}
              />
            </label>

            <div className="provider-hint">
              当前列表由此浏览器运行时动态返回，不同浏览器、不同系统语音包下可用声音会不同。
              {browserVoiceOptions.length <= 1
                ? ' 当前语言下没有匹配的浏览器语音，将继续使用浏览器默认声音。'
                : ''}
            </div>
          </>
        )}

        {settingsDraft.voice.mode === 'dashscope-proxy' && (
          <>
            <label>
              <SettingLabel>语音服务 API 密钥</SettingLabel>
              <Input
                type="password"
                value={settingsDraft.voice.apiKey}
                onChange={(event) => updateVoiceSettings('apiKey', event.target.value)}
                placeholder="sk-...（留空使用免费共享额度）"
              />
            </label>

            <label>
              <SettingLabel>语音服务代理地址</SettingLabel>
              <Input
                value={settingsDraft.voice.proxyUrl}
                onChange={(event) => updateVoiceSettings('proxyUrl', event.target.value)}
                placeholder="留空使用默认免费代理"
              />
            </label>

            <label>
              <SettingLabel>语音合成角色</SettingLabel>
              <SettingSelect
                value={settingsDraft.voice.speaker}
                onValueChange={(value) => updateVoiceSettings('speaker', value)}
                options={PROXY_TTS_SPEAKERS.map((speaker) => ({
                  value: speaker.id,
                  label: speaker.label,
                }))}
              />
            </label>

            <SettingToggle
              label="静音后自动停止收音"
              checked={settingsDraft.voice.autoStopEnabled}
              onCheckedChange={(checked) => updateVoiceSettings('autoStopEnabled', checked)}
            />
          </>
        )}
      </section>
    </div>
  );
}
