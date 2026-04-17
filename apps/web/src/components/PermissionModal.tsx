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
  return (
    <section className="permission-modal-backdrop">
      <div className="permission-modal">
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
