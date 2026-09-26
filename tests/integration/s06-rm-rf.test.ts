import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, cliJson, hashTree, lines, makeSandbox, type Sandbox } from '../helpers/sandbox.js';

// 7A.6 — `rm -rf` of the whole project (including .git) → restore into a new folder.
describe('7A.6 rm -rf toàn bộ project kể cả .git', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('restores the latest snapshot into a new directory', async () => {
    sb = await makeSandbox({ files: { 'package.json': '{"name":"app"}\n', 'src/index.ts': lines(50) } });
    sb.write('src/index.ts', lines(80));
    sb.write('src/chưa commit.ts', 'export const draft = true;\r\n');
    const expected = hashTree(sb.root);
    const saved = await cliJson(sb, ['save']);

    rmSync(sb.root, { recursive: true, force: true });

    // The project is gone, so it is addressed by its old path; list still works.
    const listed = await cliJson(sb, ['list', '--project', sb.root], { cwd: sb.base });
    expect(listed.snapshots[0].id).toBe(saved.snapshot.id);

    const target = join(sb.base, 'khôi phục');
    const res = await cli(sb, ['restore', 'latest', '--project', sb.root, '--to', target, '--yes'], { cwd: sb.base });
    expect(res.code).toBe(0);
    expect(hashTree(target)).toEqual(expected);
  });

  it('refuses a full restore into a non-empty directory', async () => {
    sb = await makeSandbox({ files: { 'a.ts': 'a\n' } });
    await cliJson(sb, ['save']);
    const res = await cli(sb, ['restore', 'latest', '--to', sb.base, '--yes']);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/không trống/);
  });
});
