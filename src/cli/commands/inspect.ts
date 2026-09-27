import type { Command } from 'commander';
import { activeAlerts, allAlerts, updateAlerts } from '../../core/alerts.js';
import { describeStats } from '../../core/catalog.js';
import { buildContext, renderContextMarkdown } from '../../core/context.js';
import { RecodeError } from '../../core/errors.js';
import { diffSnapshot, getSnapshot, readSnapshotFile } from '../../core/inspect.js';
import { toRepoPath } from '../../core/paths.js';
import type { Deps } from '../deps.js';
import { formatDateTime, json, snapshotJson } from '../format.js';

function looksBinary(buf: Buffer): boolean {
  if (buf.subarray(0, 8000).includes(0)) return true;
  return !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

export function registerInspectCommands(program: Command, deps: Deps): void {
  const { io } = deps;

  program
    .command('diff')
    .description('Xem khác biệt từ một snapshot tới hiện tại / HEAD / snapshot khác ("-" = trong snapshot, "+" = bên so sánh)')
    .argument('<id>', 'snapshot id')
    .argument('[paths...]', 'giới hạn theo file/thư mục (đặt sau --)')
    .option('--against <target>', 'current | HEAD | <snapshot id>', 'current')
    .option('--stat', 'chỉ in danh sách file thay đổi')
    .option('--json', 'xuất JSON')
    .action(async (id: string, paths: string[], opts: { against: string; stat?: boolean; json?: boolean }, cmd: Command) => {
      const rt = await deps.runtime();
      const project = await deps.project(cmd);
      const repoPaths = paths.map((p) => toRepoPath(project.root, p, io.cwd));
      const res = await diffSnapshot(rt, project, {
        snapshot: id,
        against: opts.against,
        paths: repoPaths,
        color: io.isTTY && !opts.json,
      });
      if (opts.json) {
        io.stdout(json({ from: res.from, to: res.to, files: res.files, patch: res.patch }));
        return;
      }
      if (res.files.length === 0) {
        io.stdout('Không có khác biệt.\n');
        return;
      }
      if (opts.stat) {
        for (const f of res.files) {
          const lines = f.binary ? 'binary' : `+${f.added ?? 0}/-${f.deleted ?? 0}`;
          io.stdout(`${f.status}  ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}  ${lines}\n`);
        }
        return;
      }
      io.stdout(res.patch);
    });

  program
    .command('show')
    .description('In thông tin snapshot, hoặc nội dung chính xác của một file tại snapshot')
    .argument('<id>', 'snapshot id')
    .argument('[path]', 'file cần in (đặt sau --)')
    .option('--json', 'xuất JSON')
    .action(async (id: string, path: string | undefined, opts: { json?: boolean }, cmd: Command) => {
      const project = await deps.project(cmd);
      if (path) {
        const repoPath = toRepoPath(project.root, path, io.cwd);
        const { snapshot, content } = await readSnapshotFile(project, id, repoPath);
        if (opts.json) {
          const binary = looksBinary(content);
          io.stdout(
            json({
              snapshotId: snapshot.id,
              path: repoPath,
              encoding: binary ? 'base64' : 'utf8',
              content: content.toString(binary ? 'base64' : 'utf8'),
            }),
          );
        } else {
          io.stdout(content);
        }
        return;
      }
      const s = await getSnapshot(project, id);
      if (opts.json) {
        io.stdout(json({ snapshot: snapshotJson(s) }));
        return;
      }
      const lines = [
        `Snapshot ${s.id}${s.pinned ? ' (PINNED)' : ''}`,
        `Thời gian: ${formatDateTime(s.ts)}`,
        `Nguồn: ${s.trigger}${s.message ? ` — ${s.message}` : ''}`,
        `Branch: ${s.branch ?? '-'}   HEAD lúc đó: ${s.baseCommit?.slice(0, 10) ?? '-'}`,
        `Thay đổi so với snapshot trước${s.previousId ? ` (${s.previousId})` : ''}: ${s.baseline ? 'baseline' : describeStats(s.stats)}`,
      ];
      if (s.pinReason) lines.push(`Lý do pin: ${s.pinReason}`);
      if (s.coveredAt) lines.push(`Đã có trong commit (covered) từ ${s.coveredAt}`);
      for (const f of s.files) {
        const counts = f.binary ? 'binary' : `+${f.added ?? 0}/-${f.deleted ?? 0}`;
        lines.push(`  ${f.status}  ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}  ${counts}`);
      }
      if (s.filesTruncated) lines.push('  …');
      for (const sk of s.skipped ?? []) lines.push(`  bỏ qua ${sk.path}: ${sk.reason}`);
      io.stdout(lines.join('\n') + '\n');
    });

  program
    .command('context')
    .description('Tóm tắt chuẩn hóa cho AI agent: trạng thái bảo vệ, alert, snapshot pin & gần đây')
    .option('--json', 'xuất JSON')
    .option('--md', 'xuất Markdown (mặc định)')
    .action(async (opts: { json?: boolean; md?: boolean }, cmd: Command) => {
      const rt = await deps.runtime();
      const ctx = await buildContext(rt, await deps.project(cmd));
      if (opts.json && !opts.md) io.stdout(json(ctx as unknown as Record<string, unknown>));
      else io.stdout(renderContextMarkdown(ctx, rt.now()));
    });

  program
    .command('alerts')
    .description('Xem hoặc đánh dấu đã xử lý các alert auto-pin')
    .option('--all', 'gồm cả alert đã xử lý / hết hạn')
    .option('--resolve <id>', 'đánh dấu một alert (hoặc "all") là đã xử lý')
    .option('--json', 'xuất JSON')
    .action(async (opts: { all?: boolean; resolve?: string; json?: boolean }, cmd: Command) => {
      const rt = await deps.runtime();
      const project = await deps.project(cmd);
      if (opts.resolve) {
        const target = opts.resolve;
        const changed = await updateAlerts(rt, project, (a) => target === 'all' || a.id === target, 'resolved', 'người dùng bỏ qua');
        if (changed.length === 0 && target !== 'all') throw new RecodeError(`Không có alert đang mở với id ${target}.`, 'ALERT_NOT_FOUND');
        if (opts.json) io.stdout(json({ resolved: changed }));
        else io.stdout(`Đã đánh dấu ${changed.length} alert là đã xử lý.\n`);
        return;
      }
      const alerts = opts.all ? await allAlerts(project) : await activeAlerts(rt, project);
      if (opts.json) {
        io.stdout(json({ alerts }));
        return;
      }
      if (alerts.length === 0) {
        io.stdout('Không có alert nào.\n');
        return;
      }
      for (const a of alerts) {
        io.stdout(`${a.id}  [${a.status}]  ${formatDateTime(Date.parse(a.createdAt))}  ${a.reasons.join('; ')}  → bản tốt: ${a.goodSnapshotId}\n`);
      }
    });
}
