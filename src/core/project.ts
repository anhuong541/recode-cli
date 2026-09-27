import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RecodeError } from './errors.js';
import { runGit } from './git.js';
import { canonicalPath, repoIdFor } from './paths.js';
import type { Runtime } from './runtime.js';

export interface Project {
  /** Canonical absolute path of the project root (the user's git work tree). */
  root: string;
  repoId: string;
  repoDir: string;
  storeDir: string;
  indexFile: string;
  metaFile: string;
  alertsFile: string;
  lockFile: string;
  watchFile: string;
}

export function projectFor(rt: Runtime, root: string): Project {
  const repoId = repoIdFor(root);
  const repoDir = join(rt.home, 'repos', repoId);
  return {
    root,
    repoId,
    repoDir,
    storeDir: join(repoDir, 'store.git'),
    indexFile: join(repoDir, 'index'),
    metaFile: join(repoDir, 'meta.json'),
    alertsFile: join(repoDir, 'alerts.json'),
    lockFile: join(repoDir, 'lock'),
    watchFile: join(repoDir, 'watch.json'),
  };
}

export async function gitToplevel(dir: string): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const res = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, allowFailure: true });
  if (res.code !== 0) return undefined;
  const top = res.stdout.toString('utf8').trim();
  return top === '' ? undefined : canonicalPath(top);
}

export interface ResolveProjectOptions {
  cwd: string;
  /** Explicit --project path; may point to a directory that no longer exists. */
  project?: string;
}

/**
 * Finds the project to operate on: the git work tree containing cwd (or --project), or —
 * when the work tree / .git is gone — the nearest ancestor that recode already knows.
 */
export async function resolveProject(rt: Runtime, opts: ResolveProjectOptions): Promise<Project> {
  const start = canonicalPath(opts.project ?? '.', opts.cwd);
  const top = await gitToplevel(start);
  // A known project wins over an enclosing repo: if the project's own .git was deleted,
  // git would otherwise resolve to some parent repository.
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = projectFor(rt, dir);
    if (existsSync(candidate.metaFile)) return candidate;
    if (dir === top) return candidate;
    if (dirname(dir) === dir) break;
  }
  if (opts.project) {
    throw new RecodeError(`Recode không có dữ liệu cho ${start} và đó cũng không phải Git repo.`, 'UNKNOWN_PROJECT');
  }
  throw new RecodeError(
    `${start} không nằm trong Git repo nào. Recode chỉ bảo vệ Git repo (chạy "git init" trước, hoặc dùng --project).`,
    'NOT_A_GIT_REPO',
  );
}
