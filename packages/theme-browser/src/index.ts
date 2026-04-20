export type ThemeMode = 'auto' | 'dark' | 'light';
export type EffectiveTheme = 'dark' | 'light';

export function getEffectiveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === 'auto') {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }
    return 'light';
  }
  return mode;
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;

  const effective = getEffectiveTheme(mode);
  document.documentElement.setAttribute('data-theme', effective);
  document.documentElement.style.colorScheme = effective;

  const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (meta) {
    meta.content = effective === 'dark' ? '#080808' : '#ffffff';
  }
}

export function subscribeThemeChanges(mode: ThemeMode, listener: () => void): () => void {
  if (mode !== 'auto' || typeof window === 'undefined') {
    return () => undefined;
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => listener();
  media.addEventListener('change', handler);
  return () => {
    media.removeEventListener('change', handler);
  };
}
