import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSnapshot } from '../../src/core/snapshot.js';
import { cli, cliJson, hashTree, makeSandbox, sha256, type Sandbox } from '../helpers/sandbox.js';

// 7A.10 — Vietnamese/space paths, CRLF files, files locked by an IDE (Windows).
// Every sandbox project already lives in "dự án có dấu & khoảng trắng".
describe('7A.10 đường dẫn tiếng Việt, CRLF, file bị khóa', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('handles Vietnamese file names, spaces and shell metacharacters', async () => {
    sb = await makeSandbox();
    const files = {
      'thư mục mới/tệp đầu tiên.ts': 'xin chào\n',
      'src/a b/$(echo pwned) & x.ts': 'export {}\n',
      'Tiếng Việt – ký tự đặc biệt ♥.md': '# tiêu đề\n',
    };
    for (const [p, c] of Object.entries(files)) sb.write(p, c);
    const before = hashTree(sb.root);
    const saved = await cliJson(sb, ['save']);
    for (const p of Object.keys(files)) sb.write(p, 'broken\n');

    const res = await cli(sb, ['restore', saved.snapshot.id, '--', ...Object.keys(files)]);
    expect(res.code).toBe(0);
    expect(hashTree(sb.root)).toEqual(before);

    // Paths are resolved relative to the current directory, like git.
    sb.write('thư mục mới/tệp đầu tiên.ts', 'broken again\n');
    const sub = await cli(sb, ['restore', saved.snapshot.id, '--', 'tệp đầu tiên.ts'], { cwd: join(sb.root, 'thư mục mới') });
    expect(sub.code).toBe(0);
    expect(sb.read('thư mục mới/tệp đầu tiên.ts').toString()).toBe('xin chào\n');
  });

  it('keeps CRLF, mixed and binary content byte-exact even with autocrlf and .gitattributes', async () => {
    sb = await makeSandbox({ files: { '.gitattributes': '* text=auto eol=lf\n*.ps1 text eol=crlf\n' } });
    const originalGlobal = process.env.GIT_CONFIG_GLOBAL!;
    const autocrlf = join(sb.base, 'gitconfig-autocrlf');
    writeFileSync(autocrlf, '[user]\n\tname = t\n\temail = t@t\n[core]\n\tautocrlf = true\n');
    process.env.GIT_CONFIG_GLOBAL = autocrlf;
    try {
      const contents: Record<string, Buffer> = {
        'crlf.ts': Buffer.from('line 1\r\nline 2\r\n'),
        'mixed.txt': Buffer.from('a\r\nb\nc\rd'),
        'lf.ps1': Buffer.from('Write-Host 1\nWrite-Host 2\n'),
        'bom.cs': Buffer.from('﻿class A {}\r\n', 'utf8'),
        'blob.bin': Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0a]),
      };
      for (const [p, c] of Object.entries(contents)) sb.write(p, c);
      const saved = await createSnapshot(sb.rt, sb.project, { trigger: 'manual' });
      for (const p of Object.keys(contents)) sb.write(p, 'x');
      const res = await cli(sb, ['restore', saved.snapshot.id, '--', ...Object.keys(contents)]);
      expect(res.code).toBe(0);
      for (const [p, c] of Object.entries(contents)) expect(sb.sha(p), p).toBe(sha256(c));

      const shown = await cli(sb, ['show', saved.snapshot.id, '--', 'crlf.ts']);
      expect(shown.raw.equals(contents['crlf.ts']!)).toBe(true);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = originalGlobal;
    }
  });

  it('skips files above the size limit with a warning instead of failing', async () => {
    sb = await makeSandbox({ config: { snapshot: { maxFileSizeBytes: 1024 } } });
    sb.write('small.ts', 'ok\n');
    sb.write('huge.bin', Buffer.alloc(4096, 1));
    const saved = await cliJson(sb, ['save']);
    expect(saved.skipped.map((s: any) => s.path)).toEqual(['huge.bin']);
    expect((await cli(sb, ['show', saved.snapshot.id, '--', 'small.ts'])).stdout).toBe('ok\n');
    expect((await cli(sb, ['show', saved.snapshot.id, '--', 'huge.bin'])).code).not.toBe(0);
    const ctx = await cliJson(sb, ['context']);
    expect(ctx.warnings.map((w: any) => w.type)).toContain('skipped-files');
  });

  it.runIf(process.platform === 'win32')('snapshots other files while one is locked by another process', async () => {
    sb = await makeSandbox();
    sb.write('locked.ts', 'locked\n');
    sb.write('free.ts', 'free\n');
    // Hold the file open with no sharing, like some IDEs / indexers do.
    const holder = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$f=[System.IO.File]::Open('${join(sb.root, 'locked.ts').replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Output ready; Start-Sleep -Seconds 30`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    try {
      const saved = await cliJson(sb, ['save']);
      expect(saved.skipped.map((s: any) => s.path)).toContain('locked.ts');
      expect((await cli(sb, ['show', saved.snapshot.id, '--', 'free.ts'])).stdout).toBe('free\n');
    } finally {
      holder.kill();
    }
  });
});
