import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { WaveformDefinition } from '@dg-agent/core';
import type { BrowserWaveformLibrary } from '@dg-agent/waveforms-browser';

export interface EditingWaveformState {
  id: string;
  name: string;
  description: string;
}

export interface UseWaveformManagerOptions {
  enabled: boolean;
  waveformLibrary: BrowserWaveformLibrary;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setStatusMessage: Dispatch<SetStateAction<string | null>>;
}

export function useWaveformManager(options: UseWaveformManagerOptions) {
  const { enabled, waveformLibrary, setErrorMessage, setStatusMessage } = options;
  const [waveforms, setWaveforms] = useState<WaveformDefinition[]>([]);
  const [customWaveforms, setCustomWaveforms] = useState<WaveformDefinition[]>([]);
  const [editingWaveform, setEditingWaveform] = useState<EditingWaveformState | null>(null);

  const refreshWaveforms = useCallback(async (): Promise<void> => {
    const [allWaveforms, customOnly] = await Promise.all([waveformLibrary.list(), waveformLibrary.listCustom()]);
    setWaveforms(allWaveforms);
    setCustomWaveforms(customOnly);
  }, [waveformLibrary]);

  useEffect(() => {
    if (!enabled) return;
    void refreshWaveforms();
  }, [enabled, refreshWaveforms]);

  const importWaveformFiles = useCallback(
    async (files: FileList | null): Promise<void> => {
      if (!files || files.length === 0) return;

      try {
        setErrorMessage(null);
        const imported = await waveformLibrary.importFiles(files);
        await refreshWaveforms();
        setStatusMessage(`Imported ${imported.length} waveform${imported.length > 1 ? 's' : ''}.`);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshWaveforms, setErrorMessage, setStatusMessage, waveformLibrary],
  );

  const removeWaveform = useCallback(
    async (id: string): Promise<void> => {
      try {
        await waveformLibrary.removeCustom(id);
        await refreshWaveforms();
        setStatusMessage('Custom waveform removed.');
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshWaveforms, setErrorMessage, setStatusMessage, waveformLibrary],
  );

  const openWaveformEditor = useCallback((waveform: WaveformDefinition): void => {
    setEditingWaveform({
      id: waveform.id,
      name: waveform.name,
      description: waveform.description ?? '',
    });
  }, []);

  const saveWaveformEdits = useCallback(async (): Promise<void> => {
    if (!editingWaveform) return;

    const original = customWaveforms.find((waveform) => waveform.id === editingWaveform.id);
    if (!original) {
      setEditingWaveform(null);
      return;
    }

    await waveformLibrary.saveCustom({
      ...original,
      name: editingWaveform.name.trim() || original.name,
      description: editingWaveform.description.trim(),
    });
    await refreshWaveforms();
    setEditingWaveform(null);
    setStatusMessage('Waveform details updated.');
  }, [customWaveforms, editingWaveform, refreshWaveforms, setStatusMessage, waveformLibrary]);

  return {
    waveforms,
    customWaveforms,
    editingWaveform,
    setEditingWaveform,
    refreshWaveforms,
    importWaveformFiles,
    removeWaveform,
    openWaveformEditor,
    saveWaveformEdits,
  };
}
