import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../../src/core/catalog.js';
import { protectionOf } from '../../src/core/watchstate.js';
import type { OnError } from '../../src/watch/sources.js';
import { WatchSession } from '../../src/watch/session.js';
import { cli, cliJson, makeSandbox, type Sandbox } from '../helpers/sandbox.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error('timeout');
}

describe('watch: độ bền khi watcher lỗi hoặc project biến mất', () => {
  let sb: Sandbox;
  let session: WatchSession | undefined;
  afterEach(async () => {
    await session?.stop();
    session = undefined;
    sb?.cleanup();
  });

  it('forces a full rescan when the watcher reports dropped events', async () => {
    sb = await makeSandbox({ config: { watch: { debounceMs: 100, maxWaitMs: 500 } } });
    let emitError!: OnError;
    const logs: string[] = [];
    session = new WatchSession(sb.rt, sb.project, {
      log: (l) => logs.push(l),
      // A source that never reports file events, like FSEvents after it dropped them.
      startSource: async (_root, _onPaths, onError) => {
        emitError = onError;
        return { mode: 'native', stop: async () => {} };
      },
    });
    await session.start();
    const before = (await listSnapshots(sb.project)).length;

    sb.write('src/missed.ts', 'export const missed = true;\n');
    await sleep(700);
    expect((await listSnapshots(sb.project)).length).toBe(before);

    const dropped = new Error('Events were dropped by the FSEvents client. File system must be re-scanned.');
    emitError(dropped);
    emitError(dropped);
    emitError(dropped);
    await waitFor(async () => (await listSnapshots(sb.project)).length > before);
    const latest = (await listSnapshots(sb.project)).at(-1)!;
    expect(latest.files.map((f) => f.path)).toEqual(['src/missed.ts']);
    expect(logs.filter((l) => l.includes('bỏ lỡ sự kiện'))).toHaveLength(1);
  });

  it('warns once when the project folder is deleted, then resumes when it comes back', async () => {
    sb = await makeSandbox({
      files: { 'a.ts': 'a\n' },
      config: { watch: { debounceMs: 100, maxWaitMs: 500, pollIntervalMs: 200 } },
    });
    const logs: string[] = [];
    session = new WatchSession(sb.rt, sb.project, { log: (l) => logs.push(l) });
    await session.start();
    sb.write('b.ts', 'b\n');
    await waitFor(async () => (await listSnapshots(sb.project)).some((s) => s.files.some((f) => f.path === 'b.ts')));

    rmSync(sb.root, { recursive: true, force: true });
    await waitFor(() => logs.some((l) => l.startsWith('CẢNH BÁO: thư mục project đã bị xóa')));
    await sleep(1000);
    expect(logs.filter((l) => l.startsWith('CẢNH BÁO: thư mục project đã bị xóa'))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('Lỗi'))).toEqual([]);
    expect((await protectionOf(sb.rt, sb.project)).status).toBe('project-missing');

    const restored = await cli(sb, ['restore', 'latest', '--project', sb.root, '--yes'], { cwd: sb.base });
    expect(restored.code).toBe(0);
    await waitFor(() => logs.some((l) => l.includes('xuất hiện lại')));

    sb.write('c.ts', 'c\n');
    await waitFor(async () => (await listSnapshots(sb.project)).some((s) => s.files.some((f) => f.path === 'c.ts')));
    expect((await protectionOf(sb.rt, sb.project)).status).toBe('watching');
  });

  it('context and diff explain a deleted project instead of crashing', async () => {
    sb = await makeSandbox({ files: { 'a.ts': 'a\n' } });
    sb.write('a.ts', 'b\n');
    const first = await cliJson(sb, ['save']);
    sb.write('a.ts', 'c\n');
    await cliJson(sb, ['save']);
    rmSync(sb.root, { recursive: true, force: true });

    const md = await cli(sb, ['context', '--project', sb.root], { cwd: sb.base });
    expect(md.code).toBe(0);
    expect(md.stdout).toContain('KHÔNG được bảo vệ: thư mục project không còn tồn tại');
    expect(md.stdout).toContain('HEAD: (thư mục project và .git không còn tồn tại)');

    const json = await cliJson(sb, ['context', '--project', sb.root], { cwd: sb.base });
    expect(json.project.exists).toBe(false);
    expect(json.protection.status).toBe('project-missing');
    expect(json.snapshotCount).toBe(2);

    const vsCurrent = await cli(sb, ['diff', 'latest', '--project', sb.root], { cwd: sb.base });
    expect(vsCurrent.code).toBe(1);
    expect(vsCurrent.stderr).toMatch(/không có "current" để so sánh/);

    const vsSnapshot = await cliJson(sb, ['diff', first.snapshot.id, '--against', 'latest', '--project', sb.root], {
      cwd: sb.base,
    });
    expect(vsSnapshot.files).toEqual([expect.objectContaining({ path: 'a.ts', status: 'M' })]);
  });
});
