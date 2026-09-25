import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDuration, resolveSnapshotId, snapshotIdFor } from '../../src/core/ids.js';
import { canonicalPath, projectKey, repoIdFor, toRepoPath, unreliableEventsReason } from '../../src/core/paths.js';

describe('snapshot ids', () => {
  const ts = new Date(2026, 8, 27, 14, 58, 12).getTime();

  it('formats rc_MMDD_HHmmss in local time', () => {
    expect(snapshotIdFor(ts, new Set())).toBe('rc_0927_145812');
  });

  it('adds a suffix on collision', () => {
    expect(snapshotIdFor(ts, new Set(['rc_0927_145812']))).toBe('rc_0927_145812_2');
    expect(snapshotIdFor(ts, new Set(['rc_0927_145812', 'rc_0927_145812_2']))).toBe('rc_0927_145812_3');
  });

  it('resolves exact ids, ids without prefix, unique prefixes and latest', () => {
    const ids = ['rc_0927_145812', 'rc_0927_145812_2', 'rc_0927_150001'];
    expect(resolveSnapshotId('rc_0927_145812', ids)).toBe('rc_0927_145812');
    expect(resolveSnapshotId('0927_1500', ids)).toBe('rc_0927_150001');
    expect(resolveSnapshotId('latest', ids, 'rc_0927_150001')).toBe('rc_0927_150001');
    expect(() => resolveSnapshotId('rc_0927_1458', ids)).toThrow(/nhiều snapshot/);
    expect(() => resolveSnapshotId('rc_0101', ids)).toThrow(/Không tìm thấy/);
  });

  it('parses durations', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(() => parseDuration('soon')).toThrow();
  });
});

describe('paths', () => {
  it('maps the same project to the same id even after it is deleted', () => {
    const base = canonicalPath(mkdtempSync(join(tmpdir(), 'recode paths ')));
    const project = join(base, 'dự án');
    mkdirSync(project);
    const before = repoIdFor(canonicalPath(project));
    rmSync(project, { recursive: true });
    expect(repoIdFor(canonicalPath(project))).toBe(before);
    rmSync(base, { recursive: true, force: true });
  });

  it('treats Windows paths case-insensitively and separator-agnostic', () => {
    expect(projectKey('D:\\Code\\App', 'win32')).toBe(projectKey('d:/code/app', 'win32'));
    expect(repoIdFor('D:\\Code\\App', 'win32')).toBe(repoIdFor('d:\\code\\APP', 'win32'));
    expect(projectKey('/Users/A/app', 'darwin')).not.toBe(projectKey('/users/a/app', 'darwin'));
  });

  it('converts user paths to repo-relative POSIX paths', () => {
    const base = canonicalPath(mkdtempSync(join(tmpdir(), 'recode paths ')));
    mkdirSync(join(base, 'src', 'thư mục'), { recursive: true });
    expect(toRepoPath(base, 'src/thư mục/a.ts', base)).toBe('src/thư mục/a.ts');
    expect(toRepoPath(base, 'a.ts', join(base, 'src'))).toBe('src/a.ts');
    expect(toRepoPath(base, '.', base)).toBe('.');
    expect(() => toRepoPath(base, '../outside.ts', base)).toThrow(/ngoài project/);
    rmSync(base, { recursive: true, force: true });
  });

  it('detects paths where file events are unreliable', () => {
    expect(unreliableEventsReason('\\\\wsl$\\Ubuntu\\home\\me\\app', 'win32')).toMatch(/WSL/);
    expect(unreliableEventsReason('\\\\server\\share\\app', 'win32')).toMatch(/UNC/);
    expect(unreliableEventsReason('C:\\code\\app', 'win32')).toBeUndefined();
  });
});
