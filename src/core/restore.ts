import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { updateAlerts } from './alerts.js';
import { findSnapshot, listSnapshots, type Snapshot } from './catalog.js';
import { RecodeError } from './errors.js';
import { splitNul } from './git.js';
import { canonicalPath } from './paths.js';
import type { Project } from './project.js';
import type { Runtime } from './runtime.js';
import { createSnapshotLocked, stageWorkTree } from './snapshot.js';
import { storeGit, withRepoLock } from './store.js';

export interface RestoreRequest {
  snapshot: string;
  /** Repo-relative POSIX paths; empty = whole project. */
  paths: string[];
  /** Restore into another directory (e.g. the project folder was deleted). */
  to?: string;
}

export interface RestorePlan {
  target: Snapshot;
  destination: string;
  inPlace: boolean;
  full: boolean;
  paths: string[];
  /** Files (repo-relative) that will be written. */
  files: string[];
  /** Full in-place restore only: files that exist now but not in the target snapshot. */
  extraFiles: string[];
}

export interface RestoreResult {
  plan: RestorePlan;
  preRestore?: Snapshot;
  written: string[];
  deleted: string[];
  postRestore?: Snapshot;
}

const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

function matchesPath(file: string, spec: string): boolean {
  return spec === '.' || file === spec || file.startsWith(spec.endsWith('/') ? spec : `${spec}/`);
}

async function filesInSnapshot(project: Project, commit: string, paths: string[]): Promise<string[]> {
  const res = await storeGit(project, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', commit, '--', ...paths], {
    workTree: null,
    env: LITERAL,
  });
  return splitNul(res.stdout);
}

/** Read-only except for refreshing the store's private index (to learn the current tree). */
export async function planRestore(rt: Runtime, project: Project, req: RestoreRequest): Promise<RestorePlan> {
  return withRepoLock(project, async () => {
    const target = findSnapshot(await listSnapshots(project), req.snapshot);
    const destination = req.to ? canonicalPath(req.to) : project.root;
    const inPlace = destination === project.root;
    const full = req.paths.length === 0;
    const files = await filesInSnapshot(project, target.commit, full ? [] : req.paths);

    if (!full) {
      const missing = req.paths.filter((p) => !files.some((f) => matchesPath(f, p)));
      if (missing.length > 0) {
        throw new RecodeError(
          `Không có trong snapshot ${target.id}: ${missing.join(', ')}. Xem nội dung bằng: recode show ${target.id}`,
          'PATH_NOT_IN_SNAPSHOT',
        );
      }
    }

    if (!inPlace && full && existsSync(destination) && (await readdir(destination)).length > 0) {
      throw new RecodeError(
        `Thư mục đích ${destination} không trống. Khôi phục toàn bộ vào thư mục khác chỉ được làm với thư mục mới hoặc trống.`,
        'DESTINATION_NOT_EMPTY',
      );
    }

    let extraFiles: string[] = [];
    if (full && inPlace && existsSync(project.root)) {
      const { tree } = await stageWorkTree(rt, project);
      const res = await storeGit(
        project,
        ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--diff-filter=A', target.tree, tree],
        { workTree: null },
      );
      extraFiles = splitNul(res.stdout);
    }
    return { target, destination, inPlace, full, paths: req.paths, files, extraFiles };
  });
}

async function pruneEmptyDirs(root: string, file: string): Promise<void> {
  for (let dir = dirname(join(root, file)); dir.length > root.length; dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return; // not empty (or already gone)
    }
  }
}

/**
 * Writes the planned files byte-for-byte from the snapshot. When restoring in place, the
 * current state is snapshotted (and pinned) first so the restore itself can be undone.
 * Never touches .git or the user's index.
 */
export async function applyRestore(
  rt: Runtime,
  project: Project,
  plan: RestorePlan,
  opts: { deleteExtra?: boolean } = {},
): Promise<RestoreResult> {
  return withRepoLock(project, async () => {
    const { target, destination } = plan;
    let preRestore: Snapshot | undefined;
    if (plan.inPlace && existsSync(project.root)) {
      const pre = await createSnapshotLocked(rt, project, {
        trigger: 'pre-restore',
        message: `trước khi khôi phục ${target.id}${plan.full ? '' : ` (${plan.paths.join(', ')})`}`,
        pinReason: `pre-restore: trạng thái ngay trước khi khôi phục ${target.id}`,
      });
      preRestore = pre.snapshot;
    }

    await mkdir(destination, { recursive: true });
    const tmpIndex = join(project.repoDir, `restore-${process.pid}-${randomBytes(4).toString('hex')}.index`);
    try {
      await storeGit(project, ['read-tree', target.commit], { workTree: null, indexFile: tmpIndex });
      if (plan.files.length > 0) {
        await storeGit(project, ['checkout-index', '-f', '-z', '--stdin'], {
          workTree: destination,
          indexFile: tmpIndex,
          input: plan.files.join('\0') + '\0',
        });
      }
    } finally {
      await rm(tmpIndex, { force: true });
      await rm(`${tmpIndex}.lock`, { force: true });
    }

    const deleted: string[] = [];
    if (opts.deleteExtra && plan.full && plan.inPlace) {
      for (const f of plan.extraFiles) {
        await rm(join(destination, f), { force: true });
        await pruneEmptyDirs(destination, f);
        deleted.push(f);
      }
    }

    let postRestore: Snapshot | undefined;
    if (plan.inPlace) {
      const post = await createSnapshotLocked(rt, project, {
        trigger: 'restore',
        message: `sau khi khôi phục ${target.id}`,
        skipAnomaly: true,
      });
      postRestore = post.snapshot;
      await updateAlerts(rt, project, (a) => a.goodSnapshotId === target.id, 'resolved', `restore ${target.id}`);
    }
    return { plan, preRestore, written: plan.files, deleted, postRestore };
  });
}
