import type { Command } from 'commander';
import { runGc } from '../../core/gc.js';
import { WatchSession } from '../../watch/session.js';
import type { Deps } from '../deps.js';
import { formatDateTime, json } from '../format.js';

export function registerMaintenanceCommands(program: Command, deps: Deps): void {
  const { io } = deps;

  program
    .command('gc')
    .description('Dọn snapshot theo chính sách retention (bản pin giữ 14 ngày)')
    .option('--dry-run', 'chỉ in ra những gì sẽ bị xóa')
    .option('--json', 'xuất JSON')
    .action(async (opts: { dryRun?: boolean; json?: boolean }, cmd: Command) => {
      const rt = await deps.runtime();
      const res = await runGc(rt, await deps.project(cmd), { dryRun: opts.dryRun });
      if (opts.json) {
        io.stdout(json({ ...res }));
        return;
      }
      const verb = res.dryRun ? 'Sẽ xóa' : 'Đã xóa';
      io.stdout(`${verb} ${res.deleted.length} snapshot, giữ ${res.decisions.length - res.deleted.length}.\n`);
      for (const d of res.decisions.filter((x) => !x.keep)) io.stdout(`  ${d.id}  (${d.reason})\n`);
      if (res.newlyCovered.length > 0) io.stdout(`Đánh dấu covered (đã có trong commit): ${res.newlyCovered.length}\n`);
      if (res.sizeBytes !== undefined) io.stdout(`Dung lượng store: ${(res.sizeBytes / 1024 / 1024).toFixed(1)}MB\n`);
      if (res.sizeWarning) io.stderr(`Cảnh báo: ${res.sizeWarning}\n`);
    });

  program
    .command('watch')
    .description('Theo dõi project ở foreground và snapshot liên tục (Phase 1, chưa có daemon)')
    .argument('[path]', 'thư mục project (mặc định: thư mục hiện tại)')
    .option('--poll', 'dùng polling thay cho file event (ổ mạng, WSL, Docker volume)')
    .action(async (pathArg: string | undefined, opts: { poll?: boolean }, cmd: Command) => {
      const rt = await deps.runtime();
      const project = await deps.project(cmd, pathArg);
      const session = new WatchSession(rt, project, {
        forcePoll: opts.poll,
        log: (line) => io.stdout(`[${formatDateTime(rt.now())}] ${line}\n`),
      });
      await session.start();
      await (io.waitForExit?.() ?? new Promise<void>(() => undefined));
      io.stdout('Đang dừng…\n');
      await session.stop();
    });
}
