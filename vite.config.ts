import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';

// Compute a unique build identifier once per build. Preference order:
//   1. Short git commit hash (stable across rebuilds of the same commit)
//   2. Fallback to a timestamp if git is unavailable
// A timestamp is always appended so two builds of the same commit still differ,
// which matters for hotfix republishes.
function computeBuildId(): string {
  let gitHash = 'nogit';
  try {
    gitHash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch (_) {
    /* ignore — not a git checkout */
  }
  return `${gitHash}-${Date.now()}`;
}

const BUILD_ID = computeBuildId();

// Writes dist/version.json after the bundle is emitted. The client polls this
// file (with cache-busting) to detect new deployments.
function versionManifestPlugin(): Plugin {
  return {
    name: 'dg-agent-version-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId: BUILD_ID }) + '\n',
      });
    },
  };
}

export default defineConfig({
  base: '/DG-Agent/',
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [versionManifestPlugin()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
