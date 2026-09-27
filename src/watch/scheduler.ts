export interface SchedulerOptions {
  debounceMs: number;
  maxWaitMs: number;
}

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Coalesces bursts of file events into one snapshot: runs `debounceMs` after the last
 * event, but never later than `maxWaitMs` after the first event of a burst — so a file
 * written continuously is still snapshotted regularly. Never runs two jobs at once.
 */
export class SnapshotScheduler {
  private pending = false;
  private firstTouchAt = 0;
  private timer: unknown;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly job: () => Promise<void>,
    private readonly opts: SchedulerOptions,
    private readonly clock: SchedulerClock = realClock,
  ) {}

  touch(): void {
    if (this.stopped) return;
    if (!this.pending) {
      this.pending = true;
      this.firstTouchAt = this.clock.now();
    }
    if (!this.running) this.schedule();
  }

  get isPending(): boolean {
    return this.pending;
  }

  private schedule(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    const untilMax = this.firstTouchAt + this.opts.maxWaitMs - this.clock.now();
    const delay = Math.max(0, Math.min(this.opts.debounceMs, untilMax));
    this.timer = this.clock.setTimeout(() => this.fire(), delay);
  }

  private fire(): void {
    this.timer = undefined;
    if (this.running || !this.pending) return;
    this.pending = false;
    // The job reports its own errors; a failure must not stop future snapshots.
    this.running = Promise.resolve()
      .then(this.job)
      .catch(() => undefined)
      .finally(() => {
      this.running = undefined;
      if (this.pending && !this.stopped) this.schedule();
    });
  }

  /** Runs a pending job now (if any) and waits for the in-flight one. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.running) await this.running.catch(() => undefined);
    if (this.pending) {
      this.fire();
      await this.running?.catch(() => undefined);
    }
  }

  async stop(opts: { flush?: boolean } = {}): Promise<void> {
    if (opts.flush) await this.flush();
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}
