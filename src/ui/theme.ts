/**
 * ui/theme.ts — Dark/light theme toggle.
 */

import { $ } from './index';

export function toggle(): void {
  const current = document.documentElement.getAttribute('data-theme');
  apply(current === 'dark' ? 'light' : 'dark');
}

export function apply(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('dg-agent-theme', theme);

  const iconDark = $('icon-theme-dark');
  const iconLight = $('icon-theme-light');
  if (iconDark && iconLight) {
    iconDark.classList.toggle('hidden', theme === 'dark');
    iconLight.classList.toggle('hidden', theme !== 'dark');
  }

  const meta = $('meta-theme') as HTMLMetaElement | null;
  if (meta) meta.content = theme === 'dark' ? '#080808' : '#fdf5f7';
}

export function restore(): void {
  const saved = localStorage.getItem('dg-agent-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  apply(saved);
}
