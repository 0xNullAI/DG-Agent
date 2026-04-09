/**
 * ui/dropdowns.ts — Dropdown open/close/positioning logic.
 */

import { $ } from './index';

let openDropdown: string | null = null;

export function toggle(dropdownId: string, anchorId: string): void {
  if (openDropdown === dropdownId) {
    closeAll();
    return;
  }
  closeAll();

  const dd = $(dropdownId)!;
  const anchor = $(anchorId)!;
  dd.classList.remove('hidden');
  openDropdown = dropdownId;

  // Position (desktop only — on mobile CSS forces bottom sheet)
  if (window.innerWidth > 767) {
    const rect = anchor.getBoundingClientRect();
    dd.style.top = rect.bottom + 6 + 'px';
    dd.style.left = Math.max(8, rect.left) + 'px';
    dd.style.right = '';
    dd.style.bottom = '';

    requestAnimationFrame(() => {
      const ddRect = dd.getBoundingClientRect();
      if (ddRect.right > window.innerWidth - 8) {
        dd.style.left = '';
        dd.style.right = '8px';
      }
    });
  }

  anchor.classList.add('active');
}

export function closeAll(): void {
  if (!openDropdown) return;
  const dd = $(openDropdown);
  if (dd) dd.classList.add('hidden');

  $('pill-scene')?.classList.remove('active');
  openDropdown = null;
}
