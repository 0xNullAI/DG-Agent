export interface UpdateCheckerStatus {
  hasUpdate: boolean;
  dismissed: boolean;
  remoteBuildId: string | null;
}

export interface UpdateCheckerOptions {
  currentBuildId: string;
  versionUrl: string;
  pollIntervalMs?: number;
  firstCheckDelayMs?: number;
  /**
   * When true, `start()` is a no-op. Used by non-browser shells (Tauri
   * Android) where there is no version.json endpoint to poll.
   */
  disabled?: boolean;
}

export class BrowserUpdateChecker {
  private dismissed = false;
  private remoteBuildId: string | null = null;
  private intervalId: number | null = null;
  private timeoutId: number | null = null;
  private readonly listeners = new Set<(status: UpdateCheckerStatus) => void>();

  constructor(private readonly options: UpdateCheckerOptions) {}

  start(): void {
    if (this.options.disabled) return;

    this.timeoutId = window.setTimeout(() => {
      void this.checkOnce();
    }, this.options.firstCheckDelayMs ?? 30_000);

    this.intervalId = window.setInterval(
      () => {
        void this.checkOnce();
      },
      this.options.pollIntervalMs ?? 5 * 60_000,
    );

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  stop(): void {
    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  dismiss(): void {
    this.dismissed = true;
    this.emit();
  }

  subscribe(listener: (status: UpdateCheckerStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): UpdateCheckerStatus {
    return {
      hasUpdate: Boolean(
        this.remoteBuildId && this.remoteBuildId !== this.options.currentBuildId && !this.dismissed,
      ),
      dismissed: this.dismissed,
      remoteBuildId: this.remoteBuildId,
    };
  }

  private async checkOnce(): Promise<void> {
    if (this.dismissed) return;

    try {
      const response = await fetch(`${this.options.versionUrl}?t=${Date.now()}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });
      if (!response.ok) return;

      const data = (await response.json()) as { buildId?: string };
      this.remoteBuildId = typeof data.buildId === 'string' ? data.buildId : null;
      this.emit();
    } catch {
      // ignore transient update-check failures
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void this.checkOnce();
    }
  };

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}
