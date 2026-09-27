import { afterEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../../src/core/catalog.js';
import { runGc } from '../../src/core/gc.js';
import { createSnapshot } from '../../src/core/snapshot.js';
import { cli, FakeClock, lines, makeSandbox, sha256, type Sandbox } from '../helpers/sandbox.js';

const MIN = 60_000;
const DAY = 86_400_000;

// 7A.5 — after code is deleted, 50 more changes → the good version is still there (pinned).
describe('7A.5 thêm 50 thay đổi sau khi xóa code', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('keeps the pinned snapshot through 50 snapshots and GC', async () => {
    const clock = new FakeClock();
    sb = await makeSandbox({ clock });
    const original = Buffer.from(lines(200, 'const value ='));
    sb.write('src/core.ts', original);
    const good = await createSnapshot(sb.rt, sb.project, { trigger: 'watch' });

    clock.advance(MIN);
    sb.write('src/core.ts', lines(3, 'stub'));
    const bad = await createSnapshot(sb.rt, sb.project, { trigger: 'agent-hook' });
    expect(bad.alert?.goodSnapshotId).toBe(good.snapshot.id);

    for (let i = 0; i < 50; i++) {
      clock.advance(MIN);
      sb.write('src/other.ts', `export const n = ${i};\n`);
      await createSnapshot(sb.rt, sb.project, { trigger: 'watch' });
    }
    expect((await listSnapshots(sb.project)).length).toBe(52);

    // Three hours later the unpinned history is thinned to one per 15 minutes…
    clock.advance(3 * 60 * MIN);
    const gc = await runGc(sb.rt, sb.project);
    expect(gc.deleted.length).toBeGreaterThan(40);
    expect(gc.deleted).not.toContain(good.snapshot.id);

    // …and even after 10 days the pin holds (pins last 14 days).
    clock.advance(10 * DAY);
    await runGc(sb.rt, sb.project);
    const remaining = await listSnapshots(sb.project);
    expect(remaining.map((s) => s.id)).toContain(good.snapshot.id);

    const res = await cli(sb, ['restore', good.snapshot.id, '--', 'src/core.ts']);
    expect(res.code).toBe(0);
    expect(sb.sha('src/core.ts')).toBe(sha256(original));
  });
});
