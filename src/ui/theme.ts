/**
 * ui/theme.ts — Theme mode: auto (follow system) / dark / light.
 */

import { $ } from './index';

export type ThemeMode = 'auto' | 'dark' | 'light';

const STORAGE_KEY = 'dg-agent-theme';

let mediaQuery: MediaQueryList | null = null;
let autoListener: ((e: MediaQueryListEvent) => void) | null = null;

function setDocumentTheme(effective: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', effective);
  const meta = $('meta-theme') as HTMLMetaElement | null;
  if (meta) meta.content = effective === 'dark' ? '#080808' : '#fdf5f7';
}

export function getMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'auto' || saved === 'dark' || saved === 'light') return saved;
  return 'auto';
}

export function apply(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode);

  if (mediaQuery && autoListener) {
    mediaQuery.removeEventListener('change', autoListener);
    autoListener = null;
  }

  if (mode === 'auto') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setDocumentTheme(mediaQuery.matches ? 'dark' : 'light');
    autoListener = (e) => setDocumentTheme(e.matches ? 'dark' : 'light');
    mediaQuery.addEventListener('change', autoListener);
  } else {
    setDocumentTheme(mode);
  }
}

export function restore(): void {
  apply(getMode());
}
