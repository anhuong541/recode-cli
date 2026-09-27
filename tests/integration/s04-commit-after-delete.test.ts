import { afterEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../../src/core/catalog.js';
import { runGc } from '../../src/core/gc.js';
import { createSnapshot } from '../../src/core/snapshot.js';
import { cli, FakeClock, makeSandbox, type Sandbox } from '../helpers/sandbox.js';

const HOUR = 3_600_000;

const withValidate = `export function login(u: string) {
  return validate(u);
}

export function validate(u: string) {
  if (!u) throw new Error('empty');
  return u.trim().length > 3;
}
`;
const withoutValidate = `export function login(u: string) {
  return validate(u);
}
`;

// 7A.4 — delete a function → `git add -A && git commit` → the function is still recoverable.
describe('7A.4 xóa hàm rồi commit', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('keeps the snapshot that has content no commit contains', async () => {
    const clock = new FakeClock();
    sb = await makeSandbox({ clock, files: { 'auth.ts': 'export {}\n' } });
    sb.write('auth.ts', withValidate);
    const good = await createSnapshot(sb.rt, sb.project, { trigger: 'manual' });

    clock.advance(60_000);
    sb.write('auth.ts', withoutValidate);
    await createSnapshot(sb.rt, sb.project, { trigger: 'manual' });
    sb.git('add', '-A');
    sb.git('commit', '-qm', 'remove validate');

    // GC right after the commit marks the post-delete snapshot as covered…
    const first = await runGc(sb.rt, sb.project);
    expect(first.newlyCovered).toHaveLength(1);
    expect(first.newlyCovered).not.toContain(good.snapshot.id);

    // …and a day later the covered one may go, but the one with validate() stays.
    clock.advance(25 * HOUR);
    sb.write('other.ts', 'x\n'); // a newer snapshot so the covered one is no longer "latest"
    await createSnapshot(sb.rt, sb.project, { trigger: 'manual' });
    const later = await runGc(sb.rt, sb.project);
    expect(later.deleted).not.toContain(good.snapshot.id);

    const ids = (await listSnapshots(sb.project)).map((s) => s.id);
    expect(ids).toContain(good.snapshot.id);
    const shown = await cli(sb, ['show', good.snapshot.id, '--', 'auth.ts']);
    expect(shown.stdout).toBe(withValidate);

    const res = await cli(sb, ['restore', good.snapshot.id, '--', 'auth.ts']);
    expect(res.code).toBe(0);
    expect(sb.read('auth.ts').toString()).toBe(withValidate);
  });

  it('removes a covered snapshot only after the 24h grace period', async () => {
    const clock = new FakeClock();
    sb = await makeSandbox({ clock, files: { 'a.ts': 'a\n' } });
    sb.write('a.ts', 'b\n');
    const covered = await createSnapshot(sb.rt, sb.project, { trigger: 'manual' });
    sb.git('commit', '-qam', 'b');
    clock.advance(60_000);
    sb.write('a.ts', 'c\n');
    await createSnapshot(sb.rt, sb.project, { trigger: 'manual' });

    expect((await runGc(sb.rt, sb.project)).newlyCovered).toEqual([covered.snapshot.id]);
    clock.advance(23 * HOUR);
    expect((await runGc(sb.rt, sb.project)).deleted).toEqual([]);
    clock.advance(2 * HOUR);
    expect((await runGc(sb.rt, sb.project)).deleted).toEqual([covered.snapshot.id]);
  });
});
