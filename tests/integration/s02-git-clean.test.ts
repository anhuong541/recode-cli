import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, cliJson, lines, makeSandbox, sha256, type Sandbox } from '../helpers/sandbox.js';

// 7A.2 — new untracked files → `git clean -fd` → files recovered.
describe('7A.2 git clean -fd xóa file chưa track', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('recovers untracked files and folders', async () => {
    sb = await makeSandbox({ files: { 'README.md': '# app\n' } });
    const a = Buffer.from(lines(30, 'new feature'));
    const b = Buffer.from([0, 1, 2, 3, 255, 254, 10, 13]); // binary
    sb.write('src/tính năng mới.ts', a);
    sb.write('assets/logo.bin', b);
    const first = await cliJson(sb, ['save']);

    sb.git('clean', '-fdq');
    expect(existsSync(join(sb.root, 'src/tính năng mới.ts'))).toBe(false);
    await cliJson(sb, ['save']);

    const res = await cli(sb, ['restore', first.snapshot.id, '--', 'src/tính năng mới.ts', 'assets']);
    expect(res.code).toBe(0);
    expect(sb.sha('src/tính năng mới.ts')).toBe(sha256(a));
    expect(sb.sha('assets/logo.bin')).toBe(sha256(b));
  });

  it('respects .gitignore and the built-in ignore list', async () => {
    sb = await makeSandbox({ files: { '.gitignore': 'secret.env\n' } });
    sb.write('secret.env', 'TOKEN=1');
    sb.write('node_modules/pkg/index.js', 'x');
    sb.write('dist/out.js', 'x');
    sb.write('debug.log', 'x');
    sb.write('src/app.ts', 'x');
    const saved = await cliJson(sb, ['save']);
    const shown = await cli(sb, ['show', saved.snapshot.id, '--', 'src/app.ts']);
    expect(shown.stdout).toBe('x');
    for (const p of ['secret.env', 'node_modules/pkg/index.js', 'dist/out.js', 'debug.log']) {
      expect((await cli(sb, ['show', saved.snapshot.id, '--', p])).code).not.toBe(0);
    }
  });
});
