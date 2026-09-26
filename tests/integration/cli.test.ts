import { afterEach, describe, expect, it } from 'vitest';
import { cli, cliJson, lines, makeSandbox, type Sandbox } from '../helpers/sandbox.js';

describe('CLI', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('save is idempotent when nothing changed', async () => {
    sb = await makeSandbox({ files: { 'a.ts': 'a\n' } });
    const first = await cliJson(sb, ['save', '-m', 'đầu tiên']);
    expect(first.created).toBe(true);
    expect(first.snapshot.message).toBe('đầu tiên');
    const second = await cliJson(sb, ['save']);
    expect(second.created).toBe(false);
    expect(second.snapshot.id).toBe(first.snapshot.id);
  });

  it('diff against current, HEAD and another snapshot', async () => {
    sb = await makeSandbox({ files: { 'a.ts': lines(3) } });
    sb.write('a.ts', lines(5));
    const s1 = await cliJson(sb, ['save']);
    sb.write('a.ts', lines(4));
    const s2 = await cliJson(sb, ['save']);

    const vsCurrent = await cliJson(sb, ['diff', s1.snapshot.id]);
    expect(vsCurrent.files).toEqual([expect.objectContaining({ path: 'a.ts', status: 'M', added: 0, deleted: 1 })]);
    expect(vsCurrent.patch).toContain('-line 5');

    const vsHead = await cliJson(sb, ['diff', s1.snapshot.id, '--against', 'HEAD']);
    expect(vsHead.files[0]).toMatchObject({ path: 'a.ts', deleted: 2 });

    const vsOther = await cliJson(sb, ['diff', s1.snapshot.id, '--against', s2.snapshot.id, '--', 'a.ts']);
    expect(vsOther.files).toHaveLength(1);

    const none = await cli(sb, ['diff', s2.snapshot.id]);
    expect(none.stdout).toBe('Không có khác biệt.\n');
  });

  it('list filters by --pinned, --since and --file', async () => {
    sb = await makeSandbox({ files: { 'a.ts': 'a\n' } });
    sb.write('a.ts', 'b\n');
    await cliJson(sb, ['save']);
    sb.write('src/b.ts', 'b\n');
    const s2 = await cliJson(sb, ['save']);
    await cliJson(sb, ['pin', s2.snapshot.id, '-m', 'bản đẹp']);

    const pinned = await cliJson(sb, ['list', '--pinned']);
    expect(pinned.snapshots.map((s: any) => s.id)).toEqual([s2.snapshot.id]);
    expect(pinned.snapshots[0].pinReason).toBe('bản đẹp');

    const byFile = await cliJson(sb, ['list', '--file', 'src']);
    expect(byFile.snapshots.map((s: any) => s.id)).toEqual([s2.snapshot.id]);

    expect((await cliJson(sb, ['list', '--since', '1h'])).snapshots).toHaveLength(2);

    await cliJson(sb, ['unpin', s2.snapshot.id]);
    expect((await cliJson(sb, ['list', '--pinned'])).snapshots).toEqual([]);
  });

  it('reports friendly errors with non-zero exit codes', async () => {
    sb = await makeSandbox();
    const missing = await cli(sb, ['show', 'rc_0101_000000']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Không tìm thấy snapshot/);

    const notRepo = await cli(sb, ['save'], { cwd: sb.base });
    expect(notRepo.code).toBe(1);
    expect(notRepo.stderr).toMatch(/Git repo/);

    const usage = await cli(sb, ['restore']);
    expect(usage.code).toBe(2);
  });

  it('gc --dry-run reports without deleting', async () => {
    sb = await makeSandbox({ files: { 'a.ts': 'a\n' } });
    await cliJson(sb, ['save']);
    const res = await cliJson(sb, ['gc', '--dry-run']);
    expect(res.dryRun).toBe(true);
    expect(res.deleted).toEqual([]);
  });

  it('never touches the user repository: status, index, stash and log stay the same', async () => {
    sb = await makeSandbox({ files: { 'a.ts': 'a\n' } });
    sb.write('a.ts', 'changed\n');
    sb.git('add', 'a.ts');
    sb.write('b.ts', 'untracked\n');
    const status = sb.git('status', '--porcelain');
    const index = sb.git('ls-files', '-s');
    const log = sb.git('log', '--all', '--oneline');

    const s = await cliJson(sb, ['save']);
    await cliJson(sb, ['diff', s.snapshot.id, '--against', 'HEAD']);
    await cliJson(sb, ['restore', s.snapshot.id, '--', 'a.ts']);
    await cliJson(sb, ['gc']);

    expect(sb.git('status', '--porcelain')).toBe(status);
    expect(sb.git('ls-files', '-s')).toBe(index);
    expect(sb.git('log', '--all', '--oneline')).toBe(log);
    expect(sb.git('stash', 'list')).toBe('');
    expect(sb.git('for-each-ref').includes('recode')).toBe(false);
  });
});
