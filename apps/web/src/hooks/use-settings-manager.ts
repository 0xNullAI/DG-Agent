import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserAppSettingsStore, type BrowserAppSettings } from '@dg-agent/storage-browser';

interface UseSettingsManagerResult {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: React.Dispatch<React.SetStateAction<BrowserAppSettings>>;
  settings: BrowserAppSettings;
  setSettings: React.Dispatch<React.SetStateAction<BrowserAppSettings>>;
  settingsStore: BrowserAppSettingsStore;
  resetSettings: (onDone: () => void) => void;
  deleteSavedPromptPreset: (presetId: string, onSuccess: (msg: string) => void) => void;
  flushSettingsDraft: () => void;
  clearSessionPermissionOverride: () => void;
}

export function useSettingsManager(): UseSettingsManagerResult {
  const settingsStore = useMemo(
    () =>
      new BrowserAppSettingsStore({
        env: import.meta.env,
      }),
    [],
  );
  const initialSettings = useMemo(() => settingsStore.load(), [settingsStore]);
  const [settingsDraft, setSettingsDraft] = useState<BrowserAppSettings>(initialSettings);
  const [settings, setSettings] = useState<BrowserAppSettings>(initialSettings);

  function resetSettings(onDone: () => void): void {
    const next = settingsStore.reset();
    setSettingsDraft(next);
    setSettings(next);
    onDone();
  }

  function deleteSavedPromptPreset(presetId: string, onSuccess: (msg: string) => void): void {
    setSettingsDraft((current) => {
      const nextSavedPresets = current.savedPromptPresets.filter((item) => item.id !== presetId);
      return {
        ...current,
        promptPresetId: current.promptPresetId === presetId ? 'gentle' : current.promptPresetId,
        savedPromptPresets: nextSavedPresets,
      };
    });
    onSuccess('已删除该自定义场景');
  }

  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (JSON.stringify(settingsDraft) === JSON.stringify(settings)) return;

    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      const next = settingsStore.save(settingsDraft);
      setSettings(next);
    }, 300);

    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [settingsDraft, settings, settingsStore]);

  function flushSettingsDraft(): void {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (JSON.stringify(settingsDraft) !== JSON.stringify(settings)) {
      const next = settingsStore.save(settingsDraft);
      setSettings(next);
      setSettingsDraft(next);
    }
  }

  function clearSessionPermissionOverride(): void {
    const nextSettings = settingsStore.clearSessionPermissionModeOverride();
    setSettingsDraft(nextSettings);
    setSettings(nextSettings);
  }

  return {
    settingsDraft,
    setSettingsDraft,
    settings,
    setSettings,
    settingsStore,
    resetSettings,
    deleteSavedPromptPreset,
    flushSettingsDraft,
    clearSessionPermissionOverride,
  };
}
