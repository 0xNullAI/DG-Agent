/**
 * Android-only behaviours that go on top of the React app.
 *
 * Web doesn't need any of this (no system status bar, no Android back
 * button, native browsers handle keyboard reflow themselves).
 *
 * Call `installAndroidShellBehaviours()` once at app start, before render.
 */

const DARK_BG = '#0b1020';
const LIGHT_BG = '#ffffff';

/**
 * Keep `<meta name="theme-color">` in sync with `<html data-theme="...">`.
 * Status-bar tint on Android Tauri reads from theme-color; without this
 * the status bar stays dark even after the user switches to light mode.
 */
function syncStatusBarColor(): void {
  const apply = () => {
    const theme = document.documentElement.getAttribute('data-theme') ?? 'dark';
    const colour = theme === 'light' ? LIGHT_BG : DARK_BG;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = colour;
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

/**
 * When a text input gains focus, scroll it into view above the soft
 * keyboard. Android WebView usually does this itself but is unreliable
 * inside flex / dvh layouts (the chat input is at the bottom of a
 * 100dvh flex column — WebView's auto-scroll lands too high).
 *
 * The delay lets the visualViewport shrink first; scrollIntoView then
 * targets the post-keyboard layout.
 */
function autoScrollFocusedInput(): void {
  const handler = (event: FocusEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && target.contentEditable !== 'true') {
      return;
    }
    setTimeout(() => {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 250);
  };
  document.addEventListener('focusin', handler);
}

/**
 * Intercept Android's hardware/gesture back button so it doesn't exit
 * the app on the first press. Tauri Android maps the back button to
 * the WebView's history-back; we push a synthetic state on every app
 * load so the first back press pops that state instead of leaving.
 *
 * Apps that want to react to back press should listen for
 * `window.addEventListener('app:back', ...)`. The default handler shows
 * a "再按一次退出" toast — second press within 2s actually exits.
 */
function interceptBackButton(): void {
  history.pushState({ dgaa: 'guard' }, '');
  let lastBackPress = 0;
  window.addEventListener('popstate', () => {
    const detail = new CustomEvent('app:back', { cancelable: true });
    const accepted = window.dispatchEvent(detail);
    if (accepted === false) {
      // A listener consumed it (e.g. closed a modal). Re-push the guard.
      history.pushState({ dgaa: 'guard' }, '');
      return;
    }
    const now = Date.now();
    if (now - lastBackPress < 2000) {
      // User pressed back twice quickly → really exit. Pop the guard so
      // the next popstate actually closes the activity.
      return;
    }
    lastBackPress = now;
    showBackToast('再按一次退出');
    history.pushState({ dgaa: 'guard' }, '');
  });
}

function showBackToast(text: string): void {
  let toast = document.getElementById('dgaa-back-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dgaa-back-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: 'calc(48px + env(safe-area-inset-bottom))',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '10px 18px',
      background: 'rgba(20, 20, 28, 0.92)',
      color: '#f4f4f5',
      borderRadius: '999px',
      fontSize: '13px',
      zIndex: '99999',
      pointerEvents: 'none',
      transition: 'opacity 200ms',
      opacity: '0',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  requestAnimationFrame(() => {
    toast!.style.opacity = '1';
  });
  setTimeout(() => {
    toast!.style.opacity = '0';
  }, 1500);
}

/**
 * Friendly toast/dialog shown when BLE setup fails because the user
 * denied a permission, or the platform refused to scan.
 *
 * Wraps any async call (typically `deviceClient.connect()`). On the
 * permission-denied error string thrown by `TauriBlecDeviceClient`,
 * shows a confirm dialog with instructions; on cancel, surfaces the
 * original error so the existing UI error handling still runs.
 */
export async function withBlePermissionHelp<T>(connectCall: () => Promise<T>): Promise<T> {
  try {
    return await connectCall();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/权限|permission/i.test(message)) {
      // Native confirm() is the only blocking dialog the WebView reliably
      // supports without pulling in a UI lib. The OK button advises the
      // user; we don't actually open the settings intent (would need
      // tauri-plugin-shell). Re-throw so the caller's catch still runs.
      window.alert(
        '蓝牙权限被拒绝。\n\n请到 系统设置 → 应用 → DG-Agent → 权限\n手动开启 "蓝牙" 权限后重试。',
      );
    }
    throw error;
  }
}

export function installAndroidShellBehaviours(): void {
  syncStatusBarColor();
  autoScrollFocusedInput();
  interceptBackButton();
}
