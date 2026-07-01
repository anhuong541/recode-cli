import type { Command } from 'commander';
import { RecodeError } from '../../core/errors.js';
import { toRepoPath } from '../../core/paths.js';
import { applyRestore, planRestore } from '../../core/restore.js';
import type { Deps } from '../deps.js';
import { json, snapshotJson } from '../format.js';

function preview(list: string[], max = 10): string {
  const shown = list.slice(0, max).map((f) => `  ${f}`);
  if (list.length > max) shown.push(`  … và ${list.length - max} file khác`);
  return shown.join('\n');
}

export function registerRestoreCommand(program: Command, deps: Deps): void {
  const { io } = deps;

  program
    .command('restore')
    .description('Khôi phục chính xác từng byte từ snapshot. Nên khôi phục từng file: restore <id> -- <path...>')
    .argument('<id>', 'snapshot id')
    .argument('[paths...]', 'file/thư mục cần khôi phục (đặt sau --); bỏ trống = toàn bộ project')
    .option('-y, --yes', 'không hỏi xác nhận khi khôi phục toàn bộ')
    .option('--to <dir>', 'khôi phục vào thư mục khác (ví dụ khi project đã bị xóa)')
    .option('--delete-extra', 'khi khôi phục toàn bộ: xóa file hiện có nhưng không có trong snapshot')
    .option('--json', 'xuất JSON')
    .action(
      async (
        id: string,
        paths: string[],
        opts: { yes?: boolean; to?: string; deleteExtra?: boolean; json?: boolean },
        cmd: Command,
      ) => {
        const rt = await deps.runtime();
        const project = await deps.project(cmd);
        const repoPaths = paths.map((p) => toRepoPath(project.root, p, io.cwd));
        const plan = await planRestore(rt, project, { snapshot: id, paths: repoPaths, to: opts.to });

        if (plan.full && !opts.yes) {
          if (!io.isTTY) {
            throw new RecodeError(
              'Khôi phục TOÀN BỘ project cần xác nhận. Thêm --yes, hoặc khôi phục từng file: recode restore <id> -- <path>',
              'CONFIRMATION_REQUIRED',
              2,
            );
          }
          const ok = await io.confirm(
            `Khôi phục toàn bộ ${plan.files.length} file từ ${plan.target.id} vào ${plan.destination}?\n` +
              `Trạng thái hiện tại sẽ được snapshot trước (có thể hoàn tác). Tiếp tục? [y/N] `,
          );
          if (!ok) {
            io.stdout('Đã hủy, không có gì thay đổi.\n');
            return;
          }
        }

        let deleteExtra = Boolean(opts.deleteExtra);
        if (plan.extraFiles.length > 0 && !deleteExtra && io.isTTY && !opts.json) {
          deleteExtra = await io.confirm(
            `${plan.extraFiles.length} file hiện có KHÔNG tồn tại trong ${plan.target.id}:\n${preview(plan.extraFiles)}\nXóa các file này? [y/N] `,
          );
        }

        const res = await applyRestore(rt, project, plan, { deleteExtra });
        if (opts.json) {
          io.stdout(
            json({
              snapshotId: plan.target.id,
              destination: plan.destination,
              written: res.written,
              deleted: res.deleted,
              keptExtraFiles: deleteExtra ? [] : plan.extraFiles,
              preRestore: res.preRestore ? snapshotJson(res.preRestore) : null,
            }),
          );
          return;
        }
        io.stdout(`Đã khôi phục ${res.written.length} file từ ${plan.target.id} vào ${plan.destination}.\n`);
        if (res.written.length <= 10) io.stdout(preview(res.written) + '\n');
        if (res.deleted.length > 0) io.stdout(`Đã xóa ${res.deleted.length} file không có trong snapshot.\n`);
        else if (plan.extraFiles.length > 0) {
          io.stdout(`Giữ nguyên ${plan.extraFiles.length} file không có trong snapshot (dùng --delete-extra để xóa).\n`);
        }
        if (res.preRestore) {
          io.stdout(`Hoàn tác: recode restore ${res.preRestore.id}${plan.full ? ' --yes' : ` -- ${plan.paths.join(' ')}`}\n`);
        }
      },
    );
}
