import type { Command } from 'commander';
import { resolveProject, type Project } from '../core/project.js';
import { createRuntime, type Runtime } from '../core/runtime.js';
import type { CliIO } from './io.js';

export interface Deps {
  io: CliIO;
  runtime(): Promise<Runtime>;
  project(cmd: Command, pathArg?: string): Promise<Project>;
}

export function createDeps(io: CliIO): Deps {
  let rt: Promise<Runtime> | undefined;
  const runtime = () => (rt ??= createRuntime(io.runtime));
  return {
    io,
    runtime,
    async project(cmd, pathArg) {
      const globals = cmd.optsWithGlobals<{ project?: string }>();
      return resolveProject(await runtime(), { cwd: io.cwd, project: pathArg ?? globals.project });
    },
  };
}
