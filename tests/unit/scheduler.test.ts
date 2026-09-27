import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotScheduler } from '../../src/watch/scheduler.js';

describe('SnapshotScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst into one run', async () => {
    const job = vi.fn(async () => {});
    const s = new SnapshotScheduler(job, { debounceMs: 1500, maxWaitMs: 10_000 });
    for (let i = 0; i < 10; i++) {
      s.touch();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(job).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('runs at least every maxWait during continuous writes', async () => {
    const job = vi.fn(async () => {});
    const s = new SnapshotScheduler(job, { debounceMs: 1500, maxWaitMs: 10_000 });
    // Write every 500ms for 30s: debounce never elapses, maxWait must kick in.
    for (let t = 0; t < 30_000; t += 500) {
      s.touch();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(job.mock.calls.length).toBeGreaterThanOrEqual(3);
    await s.stop();
  });

  it('never runs two jobs concurrently and re-runs for events during a job', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const job = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => (release = r));
      active--;
    });
    const s = new SnapshotScheduler(job, { debounceMs: 100, maxWaitMs: 1000 });
    s.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(job).toHaveBeenCalledTimes(1);
    s.touch(); // arrives while the first job is running
    await vi.advanceTimersByTimeAsync(500);
    expect(job).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(job).toHaveBeenCalledTimes(2);
    release();
    await s.stop();
    expect(maxActive).toBe(1);
  });

  it('keeps scheduling after a failing job', async () => {
    const job = vi.fn(async () => {
      throw new Error('boom');
    });
    const s = new SnapshotScheduler(job, { debounceMs: 100, maxWaitMs: 1000 });
    s.touch();
    await vi.advanceTimersByTimeAsync(150);
    s.touch();
    await vi.advanceTimersByTimeAsync(150);
    expect(job).toHaveBeenCalledTimes(2);
  });
});
