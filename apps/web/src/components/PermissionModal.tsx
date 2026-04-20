import { useEffect, useRef } from 'react';
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
      className="permission-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="权限请求"
    >
      <div ref={panelRef} className="permission-modal" tabIndex={-1}>
        <div className="eyebrow">权限请求</div>
        <h2>确认设备操作</h2>
        <div className="permission-summary">{summary}</div>
        <pre className="permission-args">{JSON.stringify(args, null, 2)}</pre>
        <div className="settings-actions">
          <Button variant="secondary" onClick={onDeny}>
            拒绝
          </Button>
          <Button variant="secondary" onClick={onAllowOnce}>
            仅本次允许
          </Button>
          <Button variant="secondary" onClick={onAllowTimed}>
            允许 5 分钟
          </Button>
          <Button onClick={onAllowSession}>允许本会话</Button>
        </div>
      </div>
    </section>
  );
}
