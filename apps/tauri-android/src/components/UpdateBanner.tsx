import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TauriUpdateChecker, type AndroidUpdateStatus } from '../services/update-checker.js';

// Module-level singleton: one poll loop for the app's lifetime, independent
// of this component's own mount/unmount (React.StrictMode double-mounts in
// dev, and re-subscribing must not restart the check schedule).
const checker = new TauriUpdateChecker({ repo: '0xNullAI/DG-Agent' });

// Rendered as a sibling of <App/>, not inside it — App's `<main>` is a fixed
// `h-[100dvh]` block designed to be reused verbatim across shells, so an
// Android-only banner can't be woven into its layout without touching that
// shared component. `position: fixed` here escapes App's own
// `overflow-hidden` container and paints on top, since this element isn't a
// DOM descendant of it.
export function UpdateBanner() {
  const [status, setStatus] = useState<AndroidUpdateStatus>(() => checker.getStatus());

  useEffect(() => {
    const unsubscribe = checker.subscribe(setStatus);
    checker.start();
    return () => {
      checker.stop();
      unsubscribe();
    };
  }, []);

  if (!status.hasUpdate) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[env(safe-area-inset-top)]">
      <Alert
        variant="info"
        className="pointer-events-auto mt-2 w-fit max-w-[calc(100%-1rem)] text-center shadow-[var(--shadow)] sm:max-w-[60%]"
      >
        <AlertDescription className="whitespace-normal break-words text-center">
          发现新版本 v{status.latestVersion}
        </AlertDescription>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => checker.dismiss()}>
            忽略此版本
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (status.releaseUrl) void openUrl(status.releaseUrl);
            }}
          >
            去更新
          </Button>
        </div>
      </Alert>
    </div>
  );
}
