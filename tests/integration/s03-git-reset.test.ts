import { afterEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../../src/core/catalog.js';
import { WatchSession } from '../../src/watch/session.js';
import { cli, cliJson, hashTree, lines, makeSandbox, type Sandbox } from '../helpers/sandbox.js';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

// 7A.3 — uncommitted changes → `git reset --hard` → recoverable, previous snapshot auto-pinned.
describe('7A.3 git reset --hard khi có thay đổi chưa commit', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('pins the snapshot taken before the reset and restores it', async () => {
    sb = await makeSandbox({ files: { 'app.ts': lines(10), 'lib.ts': lines(5) } });
    sb.write('app.ts', lines(12)); // small edit: content rules alone would not fire
    sb.write('new.ts', 'export {}\n');
    const before = hashTree(sb.root);
    const good = await cliJson(sb, ['save']);

    sb.git('reset', '--hard', '-q');
    sb.git('clean', '-fdq');
    const after = await cliJson(sb, ['save']);
    expect(after.alert?.goodSnapshotId).toBe(good.snapshot.id);
    expect(after.alert.reasons.join(' ')).toMatch(/HEAD thay đổi \("reset: moving to HEAD"\)/);

    const res = await cli(sb, ['restore', good.snapshot.id, '--yes']);
    expect(res.code).toBe(0);
    expect(hashTree(sb.root)).toEqual(before);
  });

  it('does not pin when HEAD moves on a clean work tree', async () => {
    sb = await makeSandbox({ files: { 'app.ts': lines(10) } });
    await cliJson(sb, ['save']);
    sb.write('b.ts', 'b\n');
    sb.git('add', '-A');
    sb.git('commit', '-qm', 'second');
    await cliJson(sb, ['save']);
    sb.git('reset', '--hard', '-q', 'HEAD~1');
    const res = await cliJson(sb, ['save']);
    expect(res.alert).toBeNull();
  });

  it('detects the reset while `recode watch` is running', async () => {
    sb = await makeSandbox({
      files: { 'app.ts': lines(10) },
      config: { watch: { debounceMs: 200, maxWaitMs: 1000, headPollMs: 100 } },
    });
    const session = new WatchSession(sb.rt, sb.project);
    await session.start();
    try {
      sb.write('app.ts', lines(11));
      await waitFor(async () => (await listSnapshots(sb.project)).length >= 2);
      sb.git('reset', '--hard', '-q');
      await waitFor(async () => (await listSnapshots(sb.project)).some((s) => s.pinned));
      const snaps = await listSnapshots(sb.project);
      const pinned = snaps.find((s) => s.pinned)!;
      expect(pinned.pinReason).toMatch(/HEAD thay đổi/);
      const shown = await cli(sb, ['show', pinned.id, '--', 'app.ts']);
      expect(shown.stdout).toBe(lines(11));
    } finally {
      await session.stop();
    }
  });
});
