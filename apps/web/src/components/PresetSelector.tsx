import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  BUILTIN_PROMPT_PRESETS,
  type PromptPreset,
  type SavedPromptPreset,
} from '@dg-agent/prompts-basic';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface PresetSelectorProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
  onSaveCurrentPromptPreset: () => void;
  onDeleteSavedPromptPreset: (presetId: string) => void;
}

function resolveActivePreset(
  presetId: string,
  savedPresets: SavedPromptPreset[],
): { name: string; icon: string } {
  const builtin = BUILTIN_PROMPT_PRESETS.find((p) => p.id === presetId);
  if (builtin) return { name: builtin.name, icon: builtin.icon ?? '💕' };
  const saved = savedPresets.find((p) => p.id === presetId);
  if (saved) return { name: saved.name, icon: '📝' };
  return { name: '温柔调情', icon: '💕' };
}

export function PresetSelector({
  settingsDraft,
  setSettingsDraft,
  onSaveCurrentPromptPreset,
  onDeleteSavedPromptPreset,
}: PresetSelectorProps) {
  const [open, setOpen] = useState(false);
  const [showCustomPrompt, setShowCustomPrompt] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const active = resolveActivePreset(
    settingsDraft.promptPresetId,
    settingsDraft.savedPromptPresets,
  );
  const selectedSavedPreset = settingsDraft.savedPromptPresets.find(
    (p) => p.id === settingsDraft.promptPresetId,
  );

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setShowCustomPrompt(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  function selectPreset(preset: PromptPreset | SavedPromptPreset) {
    setSettingsDraft((current) => ({ ...current, promptPresetId: preset.id }));
    setOpen(false);
    setShowCustomPrompt(false);
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3.5 py-1.5 text-sm font-medium text-[var(--text)] shadow-sm transition-colors hover:bg-[var(--bg-soft)]"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{active.icon}</span>
        <span className="max-w-[120px] truncate">{active.name}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-[var(--text-soft)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className="preset-dropdown absolute left-1/2 top-full z-[100] mt-2 w-[min(320px,calc(100vw-2rem))] -translate-x-1/2 rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-2 shadow-lg animate-in fade-in slide-in-from-top-1 duration-150"
        >
          <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-faint)]">
            场景模式
          </div>

          <div className="grid grid-cols-2 gap-1.5 p-1">
            {BUILTIN_PROMPT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`flex items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-sm transition-colors ${
                  settingsDraft.promptPresetId === preset.id
                    ? 'bg-[var(--accent-soft)] text-[var(--text)] font-medium'
                    : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]'
                }`}
                onClick={() => selectPreset(preset)}
              >
                <span className="text-base">{preset.icon}</span>
                <span className="truncate">{preset.name}</span>
              </button>
            ))}
          </div>

          {settingsDraft.savedPromptPresets.length > 0 && (
            <>
              <div className="mx-2 my-1.5 border-t border-[var(--surface-border)]" />
              <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-faint)]">
                已保存
              </div>
              <div className="space-y-0.5 p-1">
                {settingsDraft.savedPromptPresets.map((preset) => (
                  <div key={preset.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      className={`flex flex-1 items-center gap-2 rounded-[10px] px-3 py-2 text-left text-sm transition-colors ${
                        settingsDraft.promptPresetId === preset.id
                          ? 'bg-[var(--accent-soft)] text-[var(--text)] font-medium'
                          : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]'
                      }`}
                      onClick={() => selectPreset(preset)}
                    >
                      <span className="text-base">📝</span>
                      <span className="truncate">{preset.name}</span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                      onClick={() => onDeleteSavedPromptPreset(preset.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mx-2 my-1.5 border-t border-[var(--surface-border)]" />

          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            onClick={() => setShowCustomPrompt((v) => !v)}
          >
            <span className="text-base">✏️</span>
            <span>自定义人设</span>
          </button>

          {showCustomPrompt && (
            <div className="space-y-2 px-2 pb-2 pt-1">
              <Textarea
                value={settingsDraft.customPrompt}
                onChange={(e) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    customPrompt: e.target.value,
                  }))
                }
                rows={3}
                placeholder="描述你想要的 AI 人设和互动风格…"
                className="text-sm"
              />
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={onSaveCurrentPromptPreset}>
                  保存
                </Button>
                {selectedSavedPreset && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => onDeleteSavedPromptPreset(selectedSavedPreset.id)}
                  >
                    删除
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
