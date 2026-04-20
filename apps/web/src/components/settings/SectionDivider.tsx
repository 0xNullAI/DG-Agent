export function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-[var(--surface-border)]" />
      <span className="shrink-0 text-xs font-bold text-[var(--accent)]">{label}</span>
      <div className="h-px flex-1 bg-[var(--surface-border)]" />
    </div>
  );
}
