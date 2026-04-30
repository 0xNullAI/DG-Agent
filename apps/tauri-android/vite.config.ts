/// <reference types="node" />

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '../web/src');

const buildId = process.env.VERCEL_GIT_COMMIT_SHA ?? `tauri-${Date.now()}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  resolve: {
    alias: {
      '@': webSrc,
      '@dg-agent/web-app': webSrc,
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
  },
});
