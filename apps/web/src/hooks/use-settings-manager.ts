import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserAppSettingsStore, type BrowserAppSettings } from '@dg-agent/storage-browser';

interface UseSettingsManagerResult {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: React.Dispatch<React.SetStateAction<BrowserAppSettings>>;
  settings: BrowserAppSettings;
  setSettings: React.Dispatch<React.SetStateAction<BrowserAppSettings>>;
  settingsStore: BrowserAppSettingsStore;
  savePromptDialogOpen: boolean;
  setSavePromptDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  promptPresetName: string;
  setPromptPresetName: React.Dispatch<React.SetStateAction<string>>;
  resetSettings: (onDone: () => void) => void;
  saveCurrentPromptPreset: (onError: (msg: string) => void) => void;
  confirmSaveCurrentPromptPreset: (
    onError: (msg: string) => void,
    onSuccess: (msg: string) => void,
  ) => void;
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
  const [savePromptDialogOpen, setSavePromptDialogOpen] = useState(false);
  const [promptPresetName, setPromptPresetName] = useState('');

  function resetSettings(onDone: () => void): void {
    const next = settingsStore.reset();
    setSettingsDraft(next);
    setSettings(next);
    onDone();
  }

  function saveCurrentPromptPreset(onError: (msg: string) => void): void {
    const prompt = settingsDraft.customPrompt.trim();
    if (!prompt) {
      onError('请先输入自定义提示词，再保存预设');
      return;
    }
    setPromptPresetName('');
    setSavePromptDialogOpen(true);
  }

  function confirmSaveCurrentPromptPreset(
    onError: (msg: string) => void,
    onSuccess: (msg: string) => void,
  ): void {
    const prompt = settingsDraft.customPrompt.trim();
    if (!prompt) {
      setSavePromptDialogOpen(false);
      setPromptPresetName('');
      onError('请先输入自定义提示词，再保存预设');
      return;
    }

    const name = promptPresetName.trim();
    if (!name) {
      onError('请输入这组提示词的名称');
      return;
    }

    const preset = {
      id: `saved-${Date.now().toString(36)}`,
      name,
      prompt,
    };

    setSettingsDraft((current) => ({
      ...current,
      promptPresetId: preset.id,
      savedPromptPresets: [preset, ...current.savedPromptPresets],
    }));
    setSavePromptDialogOpen(false);
    setPromptPresetName('');
    onSuccess('已保存自定义提示词');
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
    onSuccess('已删除该自定义提示词');
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
    savePromptDialogOpen,
    setSavePromptDialogOpen,
    promptPresetName,
    setPromptPresetName,
    resetSettings,
    saveCurrentPromptPreset,
    confirmSaveCurrentPromptPreset,
    deleteSavedPromptPreset,
    flushSettingsDraft,
    clearSessionPermissionOverride,
  };
}
