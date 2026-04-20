interface SettingToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
}

export function SettingToggle({
  checked,
  onCheckedChange,
  label,
  description,
}: SettingToggleProps) {
  return (
    <label className="flex items-center justify-between gap-3 py-1 cursor-pointer">
      <div className="min-w-0">
        <span className="text-sm text-[var(--text)]">{label}</span>
        {description && (
          <div className="text-xs text-[var(--text-faint)] mt-0.5">{description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-strong)] ${
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--surface-border-strong)]'
        }`}
        onClick={() => onCheckedChange(!checked)}
      >
        <span
          className={`pointer-events-none block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? 'translate-x-[18px]' : 'translate-x-0'
          }`}
        />
      </button>
    </label>
  );
}
