/// <reference types="node" />

import { defineConfig } from 'vitest/config';

// Single vitest process across the whole monorepo.
// Each workspace with its own vitest.config.ts (currently only apps/web,
// for the @/ alias) becomes a project; the rest fall back to the
// defaults defined here.
export default defineConfig({
  test: {
    projects: [
      'apps/web',
      {
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
    ],
  },
});
