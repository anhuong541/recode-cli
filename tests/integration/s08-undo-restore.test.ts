import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, cliJson, hashTree, lines, makeSandbox, type Sandbox } from '../helpers/sandbox.js';

// 7A.8 — restore → regret → restore the pre-restore snapshot → exactly the state before.
describe('7A.8 restore rồi hoàn tác', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('full restore is undone by restoring its pre-restore snapshot', async () => {
    sb = await makeSandbox({ files: { 'a.ts': lines(10), 'b.ts': lines(10) } });
    sb.write('a.ts', lines(30, 'old'));
    const old = await cliJson(sb, ['save']);

    sb.write('a.ts', lines(35, 'new work'));
    sb.write('b.ts', lines(12));
    sb.write('c.ts', 'only exists now\n');
    const beforeRestore = hashTree(sb.root);

    const restored = await cliJson(sb, ['restore', old.snapshot.id, '--yes', '--delete-extra']);
    expect(restored.deleted).toEqual(['c.ts']);
    expect(existsSync(join(sb.root, 'c.ts'))).toBe(false);
    const preId: string = restored.preRestore.id;
    expect(restored.preRestore.pinned).toBe(true);

    const undo = await cliJson(sb, ['restore', preId, '--yes', '--delete-extra']);
    expect(undo.snapshotId).toBe(preId);
    expect(hashTree(sb.root)).toEqual(beforeRestore);
  });

  it('per-file restore leaves other files alone and can be undone', async () => {
    sb = await makeSandbox({ files: { 'a.ts': lines(10), 'b.ts': lines(10) } });
    sb.write('a.ts', lines(20));
    const first = await cliJson(sb, ['save']);
    sb.write('a.ts', lines(25, 'x'));
    sb.write('b.ts', lines(11));
    const before = hashTree(sb.root);

    const res = await cliJson(sb, ['restore', first.snapshot.id, '--', 'a.ts']);
    expect(res.written).toEqual(['a.ts']);
    expect(sb.read('b.ts').toString()).toBe(lines(11));

    await cliJson(sb, ['restore', res.preRestore.id, '--', 'a.ts']);
    expect(hashTree(sb.root)).toEqual(before);
  });

  it('full restore requires confirmation', async () => {
    sb = await makeSandbox({ files: { 'a.ts': 'a\n' } });
    sb.write('a.ts', 'b\n');
    const s = await cliJson(sb, ['save']);
    sb.write('a.ts', 'c\n');

    const noTty = await cli(sb, ['restore', s.snapshot.id]);
    expect(noTty.code).toBe(2);
    expect(noTty.stderr).toMatch(/cần xác nhận/);
    expect(sb.read('a.ts').toString()).toBe('c\n');

    const declined = await cli(sb, ['restore', s.snapshot.id], { tty: true, confirm: [false] });
    expect(declined.code).toBe(0);
    expect(sb.read('a.ts').toString()).toBe('c\n');

    const accepted = await cli(sb, ['restore', s.snapshot.id], { tty: true, confirm: [true] });
    expect(accepted.code).toBe(0);
    expect(sb.read('a.ts').toString()).toBe('b\n');
  });

  it('full restore asks before deleting extra files and keeps them when declined', async () => {
    sb = await makeSandbox({ files: { 'a.ts': 'a\n' } });
    const s = await cliJson(sb, ['save']);
    sb.write('extra.ts', 'keep me\n');
    const res = await cli(sb, ['restore', s.snapshot.id], { tty: true, confirm: [true, false] });
    expect(res.code).toBe(0);
    expect(sb.read('extra.ts').toString()).toBe('keep me\n');
    expect(res.stdout).toMatch(/Giữ nguyên 1 file/);
  });
});
