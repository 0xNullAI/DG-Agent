/**
 * update-check.ts — Detect new deployments and prompt the user to reload.
 *
 * How it works:
 *   - At build time, vite.config.ts injects `__BUILD_ID__` (git hash + timestamp)
 *     and emits `dist/version.json` containing the same id.
 *   - At runtime we remember the id we loaded with, then periodically fetch
 *     `version.json` (cache-busted) and compare. On mismatch we show a banner
 *     prompting the user to reload — we never reload automatically because the
 *     page may be mid-session with an active Bluetooth device.
 */

const CURRENT_BUILD_ID = __BUILD_ID__;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FIRST_CHECK_DELAY_MS = 30 * 1000; // 30 seconds after boot
const VERSION_URL = `${import.meta.env.BASE_URL}version.json`;

let dismissedForSession = false;
let bannerShown = false;

async function fetchRemoteBuildId(): Promise<string | null> {
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.buildId === 'string' ? data.buildId : null;
  } catch (_) {
    // Network hiccup — ignore, we'll try again next tick.
    return null;
  }
}

function showBanner(): void {
  if (bannerShown || dismissedForSession) return;
  bannerShown = true;

  const bar = document.createElement('div');
  bar.id = 'update-banner';
  bar.className = 'update-banner';
  bar.innerHTML = `
    <span class="update-banner-text">检测到新版本，点此刷新（会断开蓝牙连接）</span>
    <button type="button" class="update-banner-close" aria-label="关闭">×</button>
  `;

  const close = bar.querySelector('.update-banner-close') as HTMLButtonElement;
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissedForSession = true;
    bar.remove();
    bannerShown = false;
  });

  bar.addEventListener('click', () => {
    // Reloading will drop the BLE connection; the fix in scanAndConnect() will
    // zero the device on the next reconnect, so this is safe by design.
    location.reload();
  });

  document.body.appendChild(bar);
}

async function checkOnce(): Promise<void> {
  if (dismissedForSession || bannerShown) return;
  const remote = await fetchRemoteBuildId();
  if (!remote) return;
  if (remote !== CURRENT_BUILD_ID) {
    showBanner();
  }
}

export function initUpdateCheck(): void {
  // First check shortly after boot.
  window.setTimeout(checkOnce, FIRST_CHECK_DELAY_MS);

  // Then poll on a fixed interval.
  window.setInterval(checkOnce, POLL_INTERVAL_MS);

  // And re-check whenever the tab comes back to the foreground — this is when
  // a user is most likely to have been away long enough for a deploy to land.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkOnce();
    }
  });
}
