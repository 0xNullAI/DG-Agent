import { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface HelpTipProps {
  text: string;
  /** Where the popover anchors relative to the icon. Default: 'top'. */
  side?: 'top' | 'bottom';
}

export function HelpTip({ text, side = 'top' }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={containerRef} className="relative ml-1 inline-flex items-center align-middle">
      <button
        type="button"
        aria-label="查看说明"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--text-faint)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          role="tooltip"
          className={`absolute left-1/2 z-50 w-64 max-w-[80vw] -translate-x-1/2 whitespace-normal break-words rounded-[8px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2 text-xs leading-relaxed text-[var(--text)] shadow-lg ${
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
