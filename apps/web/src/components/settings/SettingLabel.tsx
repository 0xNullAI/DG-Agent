import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/utils';

export function SettingLabel({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
  return <span className={cn('text-sm font-semibold text-[var(--text)]', className)} {...props} />;
}
