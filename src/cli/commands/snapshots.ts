import type { Command } from 'commander';
import { describeStats, listSnapshots } from '../../core/catalog.js';
import { RecodeError } from '../../core/errors.js';
import { parseDuration } from '../../core/ids.js';
import { toRepoPath } from '../../core/paths.js';
import { pinSnapshot, unpinSnapshot } from '../../core/pins.js';
import { createSnapshot } from '../../core/snapshot.js';
import type { Deps } from '../deps.js';
import { json, snapshotJson, snapshotRow, table } from '../format.js';

const TRIGGERS = ['manual', 'agent-hook'] as const;

export function registerSnapshotCommands(program: Command, deps: Deps): void {
  const { io } = deps;

  program
    .command('save')
    .description('Tạo snapshot thủ công cho project hiện tại')
    .option('-m, --message <msg>', 'ghi chú cho snapshot')
    .option('--trigger <trigger>', `nguồn tạo snapshot (${TRIGGERS.join('|')})`, 'manual')
    .option('-q, --quiet', 'không in gì trừ khi có lỗi')
    .option('--json', 'xuất JSON')
    .action(async (opts: { message?: string; trigger: string; quiet?: boolean; json?: boolean }, cmd: Command) => {
      if (!(TRIGGERS as readonly string[]).includes(opts.trigger)) {
        throw new RecodeError(`--trigger phải là một trong: ${TRIGGERS.join(', ')}`, 'BAD_TRIGGER', 2);
      }
      const rt = await deps.runtime();
      const project = await deps.project(cmd);
      const res = await createSnapshot(rt, project, {
        trigger: opts.trigger as (typeof TRIGGERS)[number],
        message: opts.message,
      });
      if (opts.json) {
        io.stdout(
          json({
            created: res.created,
            snapshot: snapshotJson(res.snapshot),
            alert: res.alert ?? null,
            skipped: res.skipped,
          }),
        );
        return;
      }
      if (opts.quiet) return;
      if (res.created) {
        io.stdout(`Đã tạo snapshot ${res.snapshot.id} (${res.snapshot.baseline ? 'baseline' : describeStats(res.snapshot.stats)}).\n`);
      } else {
        io.stdout(`Không có thay đổi — snapshot mới nhất vẫn là ${res.snapshot.id}.\n`);
      }
      for (const s of res.skipped) io.stdout(`  bỏ qua ${s.path}: ${s.reason}\n`);
      if (res.alert) {
        io.stdout(`AUTO-PIN ${res.alert.goodSnapshotId}: ${res.alert.reasons.join('; ')}\n`);
      }
    });

  program
    .command('list')
    .description('Liệt kê snapshot của project hiện tại (mới nhất trước)')
    .option('--json', 'xuất JSON')
    .option('--pinned', 'chỉ snapshot đã pin')
    .option('--since <duration>', 'chỉ snapshot trong khoảng thời gian gần đây, ví dụ 30m, 2h, 1d')
    .option('--file <path>', 'chỉ snapshot có thay đổi ở file/thư mục này')
    .option('-n, --limit <n>', 'số snapshot tối đa', (v) => Number(v))
    .action(
      async (
        opts: { json?: boolean; pinned?: boolean; since?: string; file?: string; limit?: number },
        cmd: Command,
      ) => {
        const rt = await deps.runtime();
        const project = await deps.project(cmd);
        let snaps = (await listSnapshots(project)).reverse();
        if (opts.pinned) snaps = snaps.filter((s) => s.pinned);
        if (opts.since) {
          const cutoff = rt.now() - parseDuration(opts.since);
          snaps = snaps.filter((s) => s.ts >= cutoff);
        }
        if (opts.file) {
          const p = toRepoPath(project.root, opts.file, io.cwd);
          snaps = snaps.filter((s) =>
            s.files.some((f) => p === '.' || [f.path, f.oldPath].some((x) => x === p || x?.startsWith(`${p}/`))),
          );
        }
        if (opts.limit && opts.limit > 0) snaps = snaps.slice(0, opts.limit);
        if (opts.json) {
          io.stdout(json({ project: { root: project.root, repoId: project.repoId }, snapshots: snaps.map(snapshotJson) }));
          return;
        }
        if (snaps.length === 0) {
          io.stdout('Chưa có snapshot nào khớp.\n');
          return;
        }
        io.stdout(table([['ID', 'THỜI GIAN', 'NGUỒN', 'BRANCH', 'THAY ĐỔI', 'FILE', 'GHI CHÚ'], ...snaps.map(snapshotRow)]));
      },
    );

  program
    .command('pin')
    .description('Pin một snapshot để GC không xóa (giữ 14 ngày)')
    .argument('<id>', 'snapshot id')
    .option('-m, --reason <reason>', 'lý do pin')
    .option('--json', 'xuất JSON')
    .action(async (id: string, opts: { reason?: string; json?: boolean }, cmd: Command) => {
      const rt = await deps.runtime();
      const s = await pinSnapshot(rt, await deps.project(cmd), id, opts.reason);
      if (opts.json) io.stdout(json({ snapshot: snapshotJson(s) }));
      else io.stdout(`Đã pin ${s.id}${s.pinReason ? ` (${s.pinReason})` : ''}.\n`);
    });

  program
    .command('unpin')
    .description('Bỏ pin một snapshot')
    .argument('<id>', 'snapshot id')
    .option('--json', 'xuất JSON')
    .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
      await deps.runtime();
      const s = await unpinSnapshot(await deps.project(cmd), id);
      if (opts.json) io.stdout(json({ snapshot: snapshotJson(s) }));
      else io.stdout(`Đã bỏ pin ${s.id}.\n`);
    });
}
