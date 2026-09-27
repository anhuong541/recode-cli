import { afterEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../../src/core/catalog.js';
import { WatchSession } from '../../src/watch/session.js';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.js';

const SLOW = process.env.RECODE_SLOW_TESTS === '1';

async function writeContinuously(sb: Sandbox, durationMs: number, everyMs: number): Promise<void> {
  const end = Date.now() + durationMs;
  let i = 0;
  while (Date.now() < end) {
    sb.write('src/stream.ts', `export const tick = ${i++};\n`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// 7A.7 — writing continuously without a pause still produces snapshots (maxWait).
describe('7A.7 ghi file liên tục không nghỉ', () => {
  let sb: Sandbox;
  let session: WatchSession | undefined;
  afterEach(async () => {
    await session?.stop();
    session = undefined;
    sb?.cleanup();
  });

  it('snapshots at least every maxWait while writes never pause (scaled timings)', async () => {
    sb = await makeSandbox({ config: { watch: { debounceMs: 400, maxWaitMs: 1000 } } });
    session = new WatchSession(sb.rt, sb.project);
    await session.start();
    const before = (await listSnapshots(sb.project)).length;
    // Writes every 100ms (< debounce) for 4.5s: only maxWait can trigger snapshots.
    await writeContinuously(sb, 4500, 100);
    const during = (await listSnapshots(sb.project)).length - before;
    expect(during).toBeGreaterThanOrEqual(3);
  });

  it.runIf(SLOW)(
    'spec timings: 30s of continuous writes with debounce 1.5s / maxWait 10s',
    async () => {
      sb = await makeSandbox();
      session = new WatchSession(sb.rt, sb.project);
      await session.start();
      const before = (await listSnapshots(sb.project)).length;
      await writeContinuously(sb, 30_000, 500);
      expect((await listSnapshots(sb.project)).length - before).toBeGreaterThanOrEqual(2);
    },
    60_000,
  );

  it('coalesces a burst of writes into a single snapshot', async () => {
    sb = await makeSandbox({ config: { watch: { debounceMs: 500, maxWaitMs: 5000 } } });
    session = new WatchSession(sb.rt, sb.project);
    await session.start();
    const before = (await listSnapshots(sb.project)).length;
    for (let i = 0; i < 20; i++) sb.write(`src/f${i}.ts`, `export const v = ${i};\n`);
    await new Promise((r) => setTimeout(r, 1500));
    await session.flush();
    expect((await listSnapshots(sb.project)).length - before).toBe(1);
  });

  it('ignores changes in ignored folders', async () => {
    sb = await makeSandbox({ files: { '.gitignore': 'tmp/\n' }, config: { watch: { debounceMs: 200, maxWaitMs: 1000 } } });
    session = new WatchSession(sb.rt, sb.project);
    await session.start();
    const before = (await listSnapshots(sb.project)).length;
    for (let i = 0; i < 5; i++) {
      sb.write('node_modules/x/index.js', `${i}`);
      sb.write('tmp/cache.bin', `${i}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 800));
    await session.flush();
    expect((await listSnapshots(sb.project)).length).toBe(before);
  });
});
