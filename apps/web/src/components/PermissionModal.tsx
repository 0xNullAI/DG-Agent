import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PermissionModalProps {
  summary: string;
  args: Record<string, unknown>;
  onAllowOnce: () => void;
  onAllowTimed: () => void;
  onAllowSession: () => void;
  onDeny: () => void;
}

export function PermissionModal({
  summary,
  args,
  onAllowOnce,
  onAllowTimed,
  onAllowSession,
  onDeny,
}: PermissionModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDeny();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDeny]);

  return (
    <section
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="权限请求"
    >
      <div
        ref={panelRef}
        className="w-[320px] rounded-[16px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 shadow-xl outline-none"
        tabIndex={-1}
      >
        <div className="text-center text-xs font-medium text-[var(--accent)]">权限请求</div>
        <h2 className="mt-2 text-center text-base font-semibold text-[var(--text)]">确认设备操作</h2>
        <div className="mt-3 text-center text-sm text-[var(--text-soft)]">{summary}</div>

        <ArgsCollapsible args={args} />

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            className="rounded-[10px] text-[13px]"
            onClick={onAllowOnce}
          >
            仅本次允许
          </Button>
          <Button
            variant="secondary"
            className="rounded-[10px] text-[13px]"
            onClick={onAllowTimed}
          >
            允许 5 分钟
          </Button>
          <Button
            className="rounded-[10px] text-[13px]"
            onClick={onAllowSession}
          >
            允许本会话
          </Button>
          <Button
            variant="destructive"
            className="rounded-[10px] text-[13px]"
            onClick={onDeny}
          >
            拒绝
          </Button>
        </div>
      </div>
    </section>
  );
}

function ArgsCollapsible({ args }: { args: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);

  if (Object.keys(args).length === 0) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        className="mx-auto flex items-center gap-1 text-xs text-[var(--text-faint)] transition-colors hover:text-[var(--text-soft)]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        详细参数
      </button>
      {open && (
        <pre className="mt-2 max-h-[160px] overflow-auto rounded-[8px] bg-[var(--bg-strong)] p-3 text-[11px] leading-[1.4] text-[var(--text-soft)]">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  );
}
