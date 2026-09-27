import { afterEach, describe, expect, it } from 'vitest';
import { cli, cliJson, lines, makeSandbox, type Sandbox } from '../helpers/sandbox.js';

// 7A.1 — AI overwrites a file down to 5 lines → restore from the auto-pinned snapshot, byte-exact.
describe('7A.1 AI ghi đè file còn 5 dòng', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('auto-pins the good version and restores it byte-for-byte', async () => {
    sb = await makeSandbox({ files: { 'src/App.tsx': lines(40, 'committed') } });
    // Uncommitted edits the user cares about (CRLF + trailing space on purpose).
    const original = Buffer.from(lines(340, 'export const x =').replace(/\n/g, '\r\n').replace('= 1\r\n', '= 1  \r\n'));
    sb.write('src/App.tsx', original);
    await cliJson(sb, ['save']);

    sb.write('src/App.tsx', lines(5, 'oops'));
    const saved = await cliJson(sb, ['save']);
    expect(saved.alert).not.toBeNull();
    expect(saved.alert.reasons.join(' ')).toContain('src/App.tsx giảm từ 340 → 5 dòng');
    const goodId: string = saved.alert.goodSnapshotId;

    const pinned = await cliJson(sb, ['list', '--pinned']);
    expect(pinned.snapshots.map((s: any) => s.id)).toContain(goodId);

    const restored = await cli(sb, ['restore', goodId, '--', 'src/App.tsx']);
    expect(restored.code).toBe(0);
    expect(sb.read('src/App.tsx').equals(original)).toBe(true);
    expect(restored.stdout).toMatch(/Hoàn tác: recode restore rc_/);

    // The user's own git index and history are untouched.
    expect(sb.git('status', '--porcelain')).toBe(' M src/App.tsx\n');
    expect(sb.git('rev-list', '--count', 'HEAD').trim()).toBe('1');

    // The alert is resolved by the restore.
    const alerts = await cliJson(sb, ['alerts']);
    expect(alerts.alerts).toEqual([]);
  });

  it('context shows the alert and the pinned snapshot', async () => {
    sb = await makeSandbox();
    sb.write('login.tsx', lines(120));
    await cliJson(sb, ['save']);
    sb.write('login.tsx', '');
    await cliJson(sb, ['save', '--trigger', 'agent-hook']);
    const md = (await cli(sb, ['context', '--md'])).stdout;
    expect(md).toContain('# RECODE CONTEXT — dự án có dấu & khoảng trắng (branch: main)');
    expect(md).toMatch(/## Alert chưa xử lý\n- \d\d:\d\d — login\.tsx giảm từ 120 → 0 dòng \(do agent-hook\)\. Bản tốt: rc_\S+ \(PINNED\)/);
    expect(md).toContain('KHÔNG được bảo vệ liên tục');
    const json = await cliJson(sb, ['context']);
    expect(json.schemaVersion).toBe(1);
    expect(json.alerts).toHaveLength(1);
    expect(json.pinned).toHaveLength(1);
  });
});
