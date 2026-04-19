export interface BrowserSafetyGuardOptions {
  stopOnLeave: boolean;
  backgroundBehavior: 'stop' | 'keep';
  onStop: (reason: 'leave-page' | 'background-hidden') => void | Promise<void>;
}

export class BrowserSafetyGuard {
  constructor(private readonly options: BrowserSafetyGuardOptions) {}

  start(): () => void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return () => undefined;
    }

    let inFlight: Promise<void> | null = null;

    const invokeStop = (reason: 'leave-page' | 'background-hidden') => {
      if (inFlight) return;

      inFlight = Promise.resolve(this.options.onStop(reason)).finally(() => {
        inFlight = null;
      });
    };

    const leaveHandler = () => invokeStop('leave-page');
    const visibilityHandler = () => {
      if (document.visibilityState === 'hidden' && this.options.backgroundBehavior === 'stop') {
        // invokeStop('background-hidden'); 
      }
    };

    if (this.options.stopOnLeave) {
      window.addEventListener('pagehide', leaveHandler);
      window.addEventListener('beforeunload', leaveHandler);
    }

    document.addEventListener('visibilitychange', visibilityHandler);

    return () => {
      window.removeEventListener('pagehide', leaveHandler);
      window.removeEventListener('beforeunload', leaveHandler);
      document.removeEventListener('visibilitychange', visibilityHandler);
    };
  }
}
