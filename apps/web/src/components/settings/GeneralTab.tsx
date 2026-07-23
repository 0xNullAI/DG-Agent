import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import {
  PROVIDER_DEFINITIONS,
  createProviderSettings,
  getProviderDefinition,
  normalizeProviderSettings,
  type ProviderDefinition,
  type ProviderFieldDefinition,
  type ProviderId,
} from '@dg-agent/providers-catalog';
import {
  ConnectionTestError,
  ListModelsError,
  listModels,
  testConnection,
} from '@dg-agent/providers-openai-http';
import {
  listModelsForProvider,
  type PiAiModelInfo,
  type PiAiProviderKey,
} from '@dg-agent/providers-pi-http';
import { HelpTip } from '../HelpTip.js';
import { SettingLabel } from './SettingLabel.js';
import { SettingSelect } from './SettingSelect.js';
import { SettingToggle } from './SettingToggle.js';
import strengthStyles from './SafetyTab.module.css';

// '自定义' pinned last — every other provider stays in catalog order, both
// for the unfiltered list and for search results, so it never crowds out
// real providers near the top.
const ORDERED_PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  ...PROVIDER_DEFINITIONS.filter((provider) => provider.id !== 'custom'),
  ...PROVIDER_DEFINITIONS.filter((provider) => provider.id === 'custom'),
];

interface GeneralTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
}

export function GeneralTab({ settingsDraft, setSettingsDraft }: GeneralTabProps) {
  const selectedProviderDef = getProviderDefinition(settingsDraft.provider.providerId);

  function updateProviderField<K extends keyof BrowserAppSettings['provider']>(
    key: K,
    value: BrowserAppSettings['provider'][K],
  ): void {
    setSettingsDraft((current) => ({
      ...current,
      provider: {
        ...current.provider,
        [key]: value,
      },
      providerConfigs: {
        ...current.providerConfigs,
        [current.provider.providerId]: {
          ...current.provider,
          [key]: value,
        },
      },
    }));
  }

  function switchProvider(providerId: ProviderId): void {
    setSettingsDraft((current) => {
      const providerConfigs = {
        ...current.providerConfigs,
        [current.provider.providerId]: current.provider,
      };
      const nextProvider = normalizeProviderSettings(
        providerConfigs[providerId] ?? createProviderSettings(providerId),
      );

      return {
        ...current,
        provider: nextProvider,
        providerConfigs: {
          ...providerConfigs,
          [providerId]: nextProvider,
        },
      };
    });
  }

  function renderProviderField(field: ProviderFieldDefinition) {
    const fieldId = `provider-${field.key}`;

    if (field.type === 'select') {
      if (field.key !== 'endpoint' && field.key !== 'useStrict') {
        return null;
      }

      const value =
        field.key === 'useStrict'
          ? String(settingsDraft.provider.useStrict)
          : settingsDraft.provider[field.key];

      return (
        <label key={field.key} htmlFor={fieldId} className="settings-inline-field">
          <SettingLabel>{field.label}</SettingLabel>
          <SettingSelect
            value={value}
            onValueChange={(nextValue) => {
              if (field.key === 'endpoint') {
                updateProviderField(
                  'endpoint',
                  nextValue as BrowserAppSettings['provider']['endpoint'],
                );
                return;
              }

              if (field.key === 'useStrict') {
                updateProviderField('useStrict', nextValue === 'true');
              }
            }}
            options={(field.options ?? []).map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />
        </label>
      );
    }

    if (field.key !== 'apiKey' && field.key !== 'model' && field.key !== 'baseUrl') {
      return null;
    }

    if (field.key === 'model') {
      // Native/pi-ai-routed providers have no baseUrl to hit a `/models`
      // endpoint on — pi-ai ships its own generated model catalog per
      // provider instead, so the picker here is catalog-driven (offline,
      // no network probe) rather than the OpenAI-compat picker's live
      // `/models` fetch + "测试连接" button below.
      if (selectedProviderDef?.dialect === 'pi-ai' && selectedProviderDef.piProviderKey) {
        return (
          <div key={field.key} className="grid gap-2">
            <label htmlFor={fieldId} className="settings-inline-field">
              <SettingLabel>{field.label}</SettingLabel>
              <PiAiModelPicker
                inputId={fieldId}
                placeholder={field.placeholder}
                providerKey={selectedProviderDef.piProviderKey as PiAiProviderKey}
                value={settingsDraft.provider.model}
                onChange={(next) => updateProviderField('model', next)}
              />
            </label>
          </div>
        );
      }

      return (
        <div key={field.key} className="grid gap-2">
          <label htmlFor={fieldId} className="settings-inline-field">
            <SettingLabel>{field.label}</SettingLabel>
            <ModelPicker
              inputId={fieldId}
              placeholder={field.placeholder}
              baseUrl={settingsDraft.provider.baseUrl}
              apiKey={settingsDraft.provider.apiKey}
              providerId={settingsDraft.provider.providerId}
              value={settingsDraft.provider.model}
              onChange={(next) => updateProviderField('model', next)}
              trailing={
                <ConnectionTestButton
                  // Remount when config changes so stale results / aborted requests
                  // are cleared — avoids setState-in-effect lint rules.
                  key={`${settingsDraft.provider.baseUrl}|${settingsDraft.provider.apiKey}|${settingsDraft.provider.model}`}
                  baseUrl={settingsDraft.provider.baseUrl}
                  apiKey={settingsDraft.provider.apiKey}
                  model={settingsDraft.provider.model}
                />
              }
            />
          </label>
        </div>
      );
    }

    return (
      <label key={field.key} htmlFor={fieldId} className="settings-inline-field">
        <SettingLabel>{field.label}</SettingLabel>
        <Input
          id={fieldId}
          type={field.type}
          value={settingsDraft.provider[field.key]}
          onChange={(event) => updateProviderField(field.key, event.target.value)}
          placeholder={field.placeholder}
        />
      </label>
    );
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-section">
        <div className="settings-row-card grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3">
          <h3 className="settings-card-legend">基本设置</h3>
          <SettingLabel>主题模式</SettingLabel>
          <div className="settings-inline-field-control text-xs flex rounded-full bg-[var(--bg-strong)] p-0.5">
            {(
              [
                { value: 'auto', label: '系统' },
                { value: 'dark', label: '深色' },
                { value: 'light', label: '浅色' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={`flex-1 rounded-full px-3.5 py-1 text-xs font-medium transition-all duration-150 ${
                  settingsDraft.themeMode === option.value
                    ? 'bg-[var(--accent)] text-[var(--button-text)]'
                    : 'text-[var(--text-soft)] hover:text-[var(--text)]'
                }`}
                onClick={() =>
                  setSettingsDraft((current) => ({
                    ...current,
                    themeMode: option.value as BrowserAppSettings['themeMode'],
                  }))
                }
              >
                {option.label}
              </button>
            ))}
          </div>

          <SettingLabel className="whitespace-nowrap">
            上下文策略
            <HelpTip text="策略越复杂，模型可以记住越长的对话历史，但工具调用的稳定性可能会下降，请按需选择。" />
          </SettingLabel>
          <div className="settings-inline-field-control">
            <SettingSelect
              value={settingsDraft.modelContextStrategy}
              onValueChange={(value) =>
                setSettingsDraft((current) => ({
                  ...current,
                  modelContextStrategy: value as BrowserAppSettings['modelContextStrategy'],
                }))
              }
              options={[
                { value: 'last-user-turn', label: '基础' },
                { value: 'last-five-user-turns', label: '中等' },
                { value: 'full-history', label: '复杂' },
              ]}
            />
          </div>

          <SettingLabel className="whitespace-nowrap">
            回复多样性
            <HelpTip text="越接近 1 多样性越高，模型回复更发散；越接近 0 越保守稳定，工具调用更可控。" />
          </SettingLabel>
          <div className="settings-inline-field-control">
            <div
              className="flex items-center gap-3"
              style={
                {
                  '--strength-fill': 'var(--accent)',
                  '--strength-fill-soft': 'var(--accent-soft)',
                  '--strength-value': `${settingsDraft.temperature * 100}%`,
                } as CSSProperties
              }
            >
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settingsDraft.temperature}
                aria-label="回复多样性滑杆"
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    temperature: Number(event.target.value),
                  }))
                }
                className={`flex-1 ${strengthStyles.strengthSlider}`}
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settingsDraft.temperature}
                aria-label="回复多样性"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) {
                    setSettingsDraft((current) => ({
                      ...current,
                      temperature: Math.min(1, Math.max(0, next)),
                    }));
                  }
                }}
                className={strengthStyles.strengthValueInput}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-row-section">
        <div className="settings-row-card">
          <h3 className="settings-card-legend">模型选择</h3>

          <ProviderSelectDropdown
            currentProviderId={settingsDraft.provider.providerId}
            onSwitch={switchProvider}
          />

          {settingsDraft.provider.model && (
            <div className="text-xs text-sm text-[var(--text-faint)]">
              当前模型：
              <span className="text-[var(--text-soft)]">{settingsDraft.provider.model}</span>
            </div>
          )}

          {selectedProviderDef?.hint && (
            <div className="rounded-[8px] bg-[var(--accent-soft)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-soft)]">
              {selectedProviderDef.id === 'free' ? (
                <>
                  无需配置 API-Key，当前由{' '}
                  <a
                    href="https://aihub.071129.xyz/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-[var(--accent)] hover:text-[var(--text)]"
                  >
                    MapLeaf API
                  </a>{' '}
                  提供支持。
                </>
              ) : (
                selectedProviderDef.hint
              )}
            </div>
          )}

          {selectedProviderDef && selectedProviderDef.fields.length > 0 && (
            <div className="grid gap-3">
              {selectedProviderDef.fields.map((field) => renderProviderField(field))}
              {selectedProviderDef.fields.some((f) => f.key === 'apiKey') && (
                <SettingToggle
                  label="在当前设备记住 API 密钥"
                  checked={settingsDraft.rememberApiKey}
                  onCheckedChange={(checked) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      rememberApiKey: checked,
                    }))
                  }
                />
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

interface ModelPickerProps {
  inputId: string;
  placeholder?: string;
  baseUrl: string;
  apiKey: string;
  providerId: ProviderId;
  value: string;
  onChange: (next: string) => void;
  /** Extra controls rendered inline after the refresh button (e.g. 测试连接). */
  trailing?: ReactNode;
}

function ModelPicker({
  inputId,
  placeholder,
  baseUrl,
  apiKey,
  providerId,
  value,
  onChange,
  trailing,
}: ModelPickerProps) {
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reset cached list whenever the user switches provider — model IDs differ between vendors.
  const lastProviderRef = useRef(providerId);
  useEffect(() => {
    if (lastProviderRef.current !== providerId) {
      lastProviderRef.current = providerId;
      setModels(null);
      setError(null);
    }
  }, [providerId]);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const list = await listModels({ baseUrl, apiKey });
      setModels(list);
      // If the saved model isn't in the new list and the list is non-empty,
      // we keep it as a "(自定义)" option (rendered below) so it doesn't get lost.
      if (list.length > 0 && !value) {
        onChange(list[0] ?? '');
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '未知错误';
      setError(`无法拉取模型列表：${message}，已切换到手动输入`);
      setModels(null);
    } finally {
      setLoading(false);
    }
  }

  const showDropdown = models !== null && !error;
  const refreshDisabled = loading || !baseUrl;

  // Build dropdown options. If the saved model is not in the fetched list,
  // surface it as a "(自定义)" entry pinned to the top so we don't silently drop it.
  let options: Array<{ value: string; label: string }> = [];
  if (showDropdown && models) {
    const seen = new Set(models);
    if (value && !seen.has(value)) {
      options.push({ value, label: `${value}（自定义）` });
    }
    options = options.concat(models.map((id) => ({ value: id, label: id })));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-[200px]">
          {showDropdown ? (
            <SettingSelect
              value={value}
              onValueChange={(next) => onChange(next)}
              options={options}
            />
          ) : (
            <Input
              id={inputId}
              type="text"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder={placeholder}
              disabled={loading}
            />
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          disabled={refreshDisabled}
          className="h-10 shrink-0 rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 text-xs font-medium text-[var(--text-soft)] transition-colors hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="刷新模型列表"
        >
          {loading ? '加载中…' : '刷新'}
        </button>
        {trailing}
      </div>
      {error && <div className="text-[12px] leading-relaxed text-[var(--text-faint)]">{error}</div>}
    </div>
  );
}

interface PiAiModelPickerProps {
  inputId: string;
  placeholder?: string;
  providerKey: PiAiProviderKey;
  value: string;
  onChange: (next: string) => void;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1)).toString()}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1000)}K`;
  }
  return String(value);
}

/**
 * Model input for native/pi-ai-routed providers. Unlike `ModelPicker`
 * (OpenAI-compat, live `/models` HTTP fetch), this always stays a free-text
 * field — pi-ai's catalog is generated ahead of time and new model ids ship
 * before it's regenerated, so forcing a dropdown-only choice would block
 * users from typing a brand-new model id. "模型信息" is a manual, offline
 * lookup against pi-ai's bundled catalog (no network request) that annotates
 * the typed id with context window / max output / reasoning-support — the
 * "surface pi-ai's model catalog metadata" ask, kept intentionally small.
 */
function PiAiModelPicker({
  inputId,
  placeholder,
  providerKey,
  value,
  onChange,
}: PiAiModelPickerProps) {
  const [models, setModels] = useState<PiAiModelInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Doubles as the staleness guard for `refresh()` below — `refresh()` is
  // only ever started from a click handler, and any effect from an earlier
  // render has already flushed by the time a *new* click can happen (React
  // runs effects before the next user interaction is possible), so reading
  // this ref from an awaited `refresh()` continuation is never one render
  // behind a provider switch, even though it's only written inside an
  // effect rather than during render (this project's react-hooks/refs lint
  // rule forbids writing a ref's `.current` during render).
  const lastProviderRef = useRef(providerKey);

  useEffect(() => {
    if (lastProviderRef.current !== providerKey) {
      lastProviderRef.current = providerKey;
      setModels(null);
      setError(null);
    }
  }, [providerKey]);

  async function refresh(): Promise<void> {
    const requestedProviderKey = providerKey;
    setLoading(true);
    setError(null);
    try {
      const list = await listModelsForProvider(requestedProviderKey);
      // Stale response guard: the user switched providers while this fetch
      // was in flight. Applying it now would overwrite the newly-selected
      // provider's (possibly already-loaded, possibly still-empty) state
      // with data for a provider that isn't showing anymore.
      if (lastProviderRef.current !== requestedProviderKey) return;
      setModels(list);
    } catch (caught) {
      if (lastProviderRef.current !== requestedProviderKey) return;
      setError(caught instanceof Error ? caught.message : '未知错误');
      setModels(null);
    } finally {
      if (lastProviderRef.current === requestedProviderKey) {
        setLoading(false);
      }
    }
  }

  const activeModel = models?.find((model) => model.id === value.trim());

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-[200px]">
          <Input
            id={inputId}
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          disabled={loading}
          className="h-10 shrink-0 rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 text-xs font-medium text-[var(--text-soft)] transition-colors hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="查看模型信息"
        >
          {loading ? '加载中…' : '模型信息'}
        </button>
      </div>
      {error && (
        <div className="text-[12px] leading-relaxed text-[var(--text-faint)]">
          无法读取模型目录：{error}
        </div>
      )}
      {!error && models && (
        <div className="text-[12px] leading-relaxed text-[var(--text-faint)]">
          {activeModel ? (
            <>
              上下文 {formatTokenCount(activeModel.contextWindow)} · 最大输出{' '}
              {formatTokenCount(activeModel.maxTokens)}
              {activeModel.reasoning ? ' · 支持推理' : ''}
            </>
          ) : (
            <>
              目录中暂无该模型 id，将按输入的名称直接调用。已知模型：
              {models
                .slice(0, 5)
                .map((model) => model.id)
                .join('、')}
              {models.length > 5 ? ' 等' : ''}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface ConnectionTestButtonProps {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type ConnectionTestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'success'; latencyMs: number }
  | { kind: 'error'; message: string };

// Test button uses its own AbortController + status state (latency / error)
// rather than a shared hook with ModelPicker — the picker tracks a cached
// model list that this button does not need, and conflating their lifecycles
// would force one side to ignore half the state.
function ConnectionTestButton({ baseUrl, apiKey, model }: ConnectionTestButtonProps) {
  const [status, setStatus] = useState<ConnectionTestStatus>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight request on unmount. Reset on config change is handled
  // by the parent via a `key` prop that remounts the component.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  async function runTest(): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus({ kind: 'testing' });
    const start = performance.now();
    try {
      await testConnection({ baseUrl, apiKey, model, signal: controller.signal });
      if (controller.signal.aborted) return;
      const latencyMs = Math.round(performance.now() - start);
      setStatus({ kind: 'success', latencyMs });
    } catch (caught) {
      if (controller.signal.aborted) return;
      if ((caught as { name?: string } | null)?.name === 'AbortError') return;
      const message =
        caught instanceof ListModelsError || caught instanceof ConnectionTestError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : '未知错误';
      setStatus({ kind: 'error', message });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }

  const testing = status.kind === 'testing';
  const disabled = testing || !baseUrl;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void runTest();
        }}
        disabled={disabled}
        className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 text-xs font-medium text-[var(--text-soft)] transition-colors hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="测试连接"
      >
        <RefreshCw size={14} className={testing ? 'animate-spin' : undefined} aria-hidden />
        {testing ? '测试中…' : '测试连接'}
      </button>
      {status.kind === 'success' && (
        <span className="text-[12px] font-medium text-[var(--accent)]">
          连接成功 · {status.latencyMs} ms
        </span>
      )}
      {status.kind === 'error' && (
        <span className="basis-full text-[12px] leading-relaxed text-[var(--danger)]">
          连接失败：{status.message}
        </span>
      )}
    </>
  );
}

function ProviderSelectDropdown({
  currentProviderId,
  onSwitch,
}: {
  currentProviderId: ProviderId;
  onSwitch: (id: ProviderId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  // Focus the search box fresh every time the panel opens. The query itself
  // is reset from the trigger's click handler (see below), not here — doing
  // it here would be a setState-in-effect (React discourages synchronous
  // setState from an effect body).
  useEffect(() => {
    if (open) {
      searchInputRef.current?.focus();
    }
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? ORDERED_PROVIDER_DEFINITIONS.filter(
        (provider) =>
          provider.name.toLowerCase().includes(normalizedQuery) ||
          provider.id.toLowerCase().includes(normalizedQuery),
      )
    : ORDERED_PROVIDER_DEFINITIONS;

  const current = getProviderDefinition(currentProviderId);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="flex h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 text-left text-sm text-[var(--text)] transition-colors hover:border-[var(--text-faint)]"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) setQuery('');
        }}
      >
        <span className="truncate">{current?.name ?? '选择服务商'}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-[var(--text-faint)] transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-full overflow-hidden rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-lg">
          <div className="border-b border-[var(--surface-border)] p-2">
            <Input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 AI 服务商…"
              className="h-9"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-[var(--text-faint)]">
                未找到匹配的服务商
              </div>
            ) : (
              filtered.map((provider) => {
                const active = provider.id === currentProviderId;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--bg-soft)]',
                      active ? 'text-[var(--accent)]' : 'text-[var(--text)]',
                      !provider.browserSupported && 'opacity-50',
                    )}
                    onClick={() => {
                      onSwitch(provider.id);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{provider.name}</span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
