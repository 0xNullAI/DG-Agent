import type { Dispatch, SetStateAction } from 'react';
import { PROXY_TTS_SPEAKERS } from '@dg-agent/audio-browser';
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

export function VoiceTab({ settingsDraft, setSettingsDraft }: VoiceTabProps) {
  const voiceLanguageOptions = VOICE_LANGUAGE_OPTIONS.some(
    (option) => option.value === settingsDraft.voiceLanguage,
  )
    ? VOICE_LANGUAGE_OPTIONS
    : [
        ...VOICE_LANGUAGE_OPTIONS,
        { value: settingsDraft.voiceLanguage, label: `当前：${settingsDraft.voiceLanguage}` },
      ];

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
          label="启用语音输入"
          checked={settingsDraft.voiceInputEnabled}
          onCheckedChange={(checked) =>
            setSettingsDraft((current) => ({
              ...current,
              voiceInputEnabled: checked,
            }))
          }
        />

        <SettingToggle
          label="朗读 AI 回复"
          checked={settingsDraft.ttsEnabled}
          onCheckedChange={(checked) =>
            setSettingsDraft((current) => ({
              ...current,
              ttsEnabled: checked,
            }))
          }
        />

        <SettingSegmented
          label="语音后端"
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
            兼容旧版语音链路：浏览器采集麦克风，经过 WebSocket 代理进行
            ASR/TTS，留空代理地址时使用内置免费代理
          </div>
        )}

        <label className="settings-inline-field">
          <SettingLabel>语音语言</SettingLabel>
          <SettingSelect
            value={settingsDraft.voiceLanguage}
            onValueChange={(value) =>
              setSettingsDraft((current) => ({
                ...current,
                voiceLanguage: value,
              }))
            }
            options={voiceLanguageOptions}
          />
        </label>

        {settingsDraft.voice.mode === 'dashscope-proxy' && (
          <>
            <label>
              <SettingLabel>语音 API 密钥</SettingLabel>
              <Input
                type="password"
                value={settingsDraft.voice.apiKey}
                onChange={(event) => updateVoiceSettings('apiKey', event.target.value)}
                placeholder="sk-...（留空使用免费共享额度）"
              />
            </label>

            <label>
              <SettingLabel>语音代理地址</SettingLabel>
              <Input
                value={settingsDraft.voice.proxyUrl}
                onChange={(event) => updateVoiceSettings('proxyUrl', event.target.value)}
                placeholder="留空使用默认免费代理"
              />
            </label>

            <label>
              <SettingLabel>语音发音人</SettingLabel>
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
