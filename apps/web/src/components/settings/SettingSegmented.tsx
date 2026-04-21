import { SettingLabel } from './SettingLabel.js';

export interface SegmentOption {
  value: string;
  label: string;
}

interface SettingSegmentedProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentOption[];
  label?: string;
}

export function SettingSegmented({ value, onValueChange, options, label }: SettingSegmentedProps) {
  return (
    <label className="space-y-1.5">
      {label && <SettingLabel>{label}</SettingLabel>}
      <div className="flex rounded-[10px] bg-[var(--bg-strong)] p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`!text-sm flex-1 rounded-[8px] px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
              value === option.value
                ? 'bg-[var(--bg-elevated)] text-[var(--text)] '
                : 'text-[var(--text-soft)] hover:text-[var(--text)]'
            }`}
            onClick={() => onValueChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </label>
  );
}
