import { getVersion } from '@tauri-apps/api/app';

export interface AndroidUpdateStatus {
  hasUpdate: boolean;
  dismissed: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
}

export interface UpdateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TauriUpdateCheckerOptions {
  /** GitHub `owner/repo` to poll `releases/latest` on, e.g. "0xNullAI/DG-Agent". */
  repo: string;
  pollIntervalMs?: number;
  firstCheckDelayMs?: number;
  storage?: UpdateStorage;
  getCurrentVersion?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

const DISMISSED_KEY = 'dg-agent-android-update-dismissed-version';

function inMemoryStorage(): UpdateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

/** Compares dotted numeric version strings (e.g. "5.4.2"); true iff `remote` is strictly newer than `current`. */
export function isNewerVersion(remote: string, current: string): boolean {
  const remoteParts = remote.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const currentParts = current.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(remoteParts.length, currentParts.length);
  for (let i = 0; i < length; i++) {
    const r = remoteParts[i] ?? 0;
    const c = currentParts[i] ?? 0;
    if (r !== c) return r > c;
  }
  return false;
}

/**
 * Polls GitHub's `releases/latest` API and compares its tag against the
 * running APK's own versionName (via Tauri's `getVersion()`). This app is
 * side-loaded (no Play Store), so there's no silent-update path — the most
 * this can do is surface a dismissible prompt pointing at the release page,
 * where the user downloads + installs the new APK themselves through
 * Android's own package installer.
 */
export class TauriUpdateChecker {
  private dismissed = false;
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private currentVersion: string | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(status: AndroidUpdateStatus) => void>();
  private readonly storage: UpdateStorage;

  constructor(private readonly options: TauriUpdateCheckerOptions) {
    this.storage =
      options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : inMemoryStorage());
  }

  start(): void {
    this.timeoutId = setTimeout(() => {
      void this.checkOnce();
    }, this.options.firstCheckDelayMs ?? 5_000);
    this.intervalId = setInterval(
      () => {
        void this.checkOnce();
      },
      this.options.pollIntervalMs ?? 60 * 60_000,
    );
  }

  stop(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  dismiss(): void {
    this.dismissed = true;
    if (this.latestVersion) {
      this.storage.setItem(DISMISSED_KEY, this.latestVersion);
    }
    this.emit();
  }

  subscribe(listener: (status: AndroidUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): AndroidUpdateStatus {
    return {
      hasUpdate: Boolean(
        this.latestVersion &&
        this.currentVersion &&
        !this.dismissed &&
        isNewerVersion(this.latestVersion, this.currentVersion),
      ),
      dismissed: this.dismissed,
      latestVersion: this.latestVersion,
      releaseUrl: this.releaseUrl,
    };
  }

  private async checkOnce(): Promise<void> {
    try {
      const getCurrentVersion = this.options.getCurrentVersion ?? getVersion;
      const fetchImpl = this.options.fetchImpl ?? fetch;
      if (this.currentVersion === null) {
        this.currentVersion = await getCurrentVersion();
      }

      const response = await fetchImpl(
        `https://api.github.com/repos/${this.options.repo}/releases/latest`,
        { headers: { Accept: 'application/vnd.github+json' } },
      );
      if (!response.ok) return;

      const data = (await response.json()) as { tag_name?: string; html_url?: string };
      const tag = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : null;
      if (!tag) return;

      this.latestVersion = tag;
      this.releaseUrl = typeof data.html_url === 'string' ? data.html_url : null;
      this.dismissed = this.storage.getItem(DISMISSED_KEY) === tag;
      this.emit();
    } catch {
      // ignore transient update-check failures — same policy as the web
      // update checker (services/update-checker.ts): a failed poll just
      // retries on the next interval instead of surfacing an error.
    }
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}
