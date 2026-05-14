export class WatcherSleeper {
  private _timer: ReturnType<typeof setTimeout> | null;
  private _resolve: (() => void) | null;
  private _pollInterval: ReturnType<typeof setInterval> | null;

  constructor() {
    this._timer = null;
    this._resolve = null;
    this._pollInterval = null;
  }

  wake() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.();
  }

  async sleep(ms: number, isRunning: () => boolean) {
    if (!isRunning() || ms <= 0) return;
    const promise = new Promise<void>((resolve) => {
      this._resolve = () => {
        this._timer = null;
        this._resolve = null;
        resolve();
      };
      this._timer = setTimeout(() => {
        this._timer = null;
        if (this._resolve === resolve) {
          this._resolve = null;
          resolve();
        }
      }, ms);
    });
    // Poll isRunning every 500ms so shutdown doesn't wait for the full sleep duration
    return this._withInterruptiblePoll(promise, isRunning);
  }

  async _withInterruptiblePoll(promise: Promise<void>, isRunning: () => boolean) {
    const pollMs = 500;
    const pollPromise = new Promise<void>((resolve) => {
      this._pollInterval = setInterval(() => {
        if (!isRunning()) {
          this.wake();
          resolve();
        }
      }, pollMs);
    });
    try {
      await Promise.race([promise, pollPromise]);
    } finally {
      if (this._pollInterval) {
        clearInterval(this._pollInterval);
        this._pollInterval = null;
      }
    }
  }
}
