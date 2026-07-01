import { Command, CommanderError } from 'commander';
import { RecodeError } from '../core/errors.js';
import { registerInspectCommands } from './commands/inspect.js';
import { registerMaintenanceCommands } from './commands/maintenance.js';
import { registerRestoreCommand } from './commands/restore.js';
import { registerSnapshotCommands } from './commands/snapshots.js';
import { createDeps } from './deps.js';
import type { CliIO } from './io.js';

export const VERSION = '0.1.0';

export function buildProgram(io: CliIO): Command {
  const program = new Command('recode')
    .description('Snapshot liên tục code CHƯA commit, khôi phục chính xác từng byte.')
    .version(VERSION)
    .option('--project <path>', 'project cần thao tác (mặc định: Git repo chứa thư mục hiện tại)')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
    });
  const deps = createDeps(io);
  registerSnapshotCommands(program, deps);
  registerInspectCommands(program, deps);
  registerRestoreCommand(program, deps);
  registerMaintenanceCommands(program, deps);
  for (const cmd of program.commands) cmd.exitOverride();
  return program;
}

/** Runs the CLI with injected I/O; returns the process exit code. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 1 ? 2 : err.exitCode;
    if (err instanceof RecodeError) {
      io.stderr(`recode: ${err.message}\n`);
      return err.exitCode;
    }
    io.stderr(`recode: lỗi không mong đợi: ${(err as Error).stack ?? String(err)}\n`);
    return 1;
  }
}
