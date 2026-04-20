import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  BUILTIN_PROMPT_PRESETS,
  type PromptPreset,
  type SavedPromptPreset,
} from '@dg-agent/prompts-basic';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface PresetSelectorProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
  onSaveCurrentPromptPreset: () => void;
  onDeleteSavedPromptPreset: (presetId: string) => void;
}

export function PresetSelector({
  settingsDraft,
  setSettingsDraft,
  onSaveCurrentPromptPreset,
  onDeleteSavedPromptPreset,
}: PresetSelectorProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');

  function selectPreset(id: string) {
    setSettingsDraft((current) => ({ ...current, promptPresetId: id }));
  }

  function startEdit(preset: SavedPromptPreset) {
    setEditingId(preset.id);
    setEditName(preset.name);
    setEditPrompt(preset.prompt);
    setCreating(false);
  }

  function saveEdit() {
    if (!editingId || !editName.trim()) return;
    setSettingsDraft((current) => ({
      ...current,
      savedPromptPresets: current.savedPromptPresets.map((p) =>
        p.id === editingId ? { ...p, name: editName.trim(), prompt: editPrompt } : p,
      ),
    }));
    setEditingId(null);
  }

  function startCreate() {
    setCreating(true);
    setEditingId(null);
    setNewName('');
    setNewPrompt('');
  }

  function confirmCreate() {
    if (!newName.trim()) return;
    const id = `custom-${Date.now()}`;
    setSettingsDraft((current) => ({
      ...current,
      promptPresetId: id,
      savedPromptPresets: [
        ...current.savedPromptPresets,
        { id, name: newName.trim(), prompt: newPrompt },
      ],
    }));
    setCreating(false);
    setNewName('');
    setNewPrompt('');
  }

  return (
    <div className="space-y-4">
      {/* Built-in presets */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-[var(--surface-border)]" />
        <span className="shrink-0 text-xs font-bold text-[var(--accent)]">内置场景</span>
        <div className="h-px flex-1 bg-[var(--surface-border)]" />
      </div>

      <div className="space-y-1.5">
        {BUILTIN_PROMPT_PRESETS.map((preset) => (
          <PresetItem
            key={preset.id}
            name={preset.name}
            icon={preset.icon ?? '💕'}
            description={preset.description}
            active={settingsDraft.promptPresetId === preset.id}
            onClick={() => selectPreset(preset.id)}
          />
        ))}
      </div>

      {/* User-saved presets */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-[var(--surface-border)]" />
        <span className="shrink-0 text-xs font-bold text-[var(--accent)]">自定义场景</span>
        <div className="h-px flex-1 bg-[var(--surface-border)]" />
      </div>

      {settingsDraft.savedPromptPresets.length === 0 && !creating && (
        <div className="py-4 text-center text-sm text-[var(--text-faint)]">
          还没有自定义场景，点击下方按钮创建
        </div>
      )}

      <div className="space-y-1.5">
        {settingsDraft.savedPromptPresets.map((preset) => {
          if (editingId === preset.id) {
            return (
              <div
                key={preset.id}
                className="space-y-2 rounded-[12px] border border-[var(--accent)] bg-[var(--bg-strong)] p-3"
              >
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="模式名称"
                  className="text-sm"
                />
                <Textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  rows={4}
                  placeholder="描述 AI 的人设和互动风格…"
                  className="text-sm"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveEdit}>
                    保存
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                    取消
                  </Button>
                </div>
              </div>
            );
          }

          return (
            <div key={preset.id} className="group flex items-center gap-1">
              <PresetItem
                name={preset.name}
                icon="📝"
                active={settingsDraft.promptPresetId === preset.id}
                onClick={() => selectPreset(preset.id)}
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--text)]"
                onClick={() => startEdit(preset)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                onClick={() => onDeleteSavedPromptPreset(preset.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </div>

      {/* Create new */}
      {creating ? (
        <div className="space-y-2 rounded-[12px] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-3">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="模式名称"
            className="text-sm"
            autoFocus
          />
          <Textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            rows={4}
            placeholder="描述 AI 的人设和互动风格…"
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={confirmCreate} disabled={!newName.trim()}>
              创建
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          className="w-full justify-center gap-2 rounded-[10px] border border-dashed border-[var(--surface-border)] text-[var(--text-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          onClick={startCreate}
        >
          <Plus className="h-4 w-4" />
          新建场景
        </Button>
      )}
    </div>
  );
}

function PresetItem({
  name,
  icon,
  description,
  active,
  onClick,
  className,
}: {
  name: string;
  icon: string;
  description?: string;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors',
        active
          ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
          : 'hover:bg-[var(--bg-soft)]',
        className,
      )}
      onClick={onClick}
    >
      <span className="shrink-0 text-lg">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm', active ? 'font-medium text-[var(--text)]' : 'text-[var(--text)]')}>
          {name}
        </div>
        {description && (
          <div className="mt-0.5 truncate text-[12px] text-[var(--text-faint)]">{description}</div>
        )}
      </div>
      {active && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
    </button>
  );
}
