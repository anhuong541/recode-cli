import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { addAlert, type Alert } from './alerts.js';
import { detectContentAnomalies, detectHeadAnomaly, type AnomalyFinding } from './anomaly.js';
import {
  listSnapshots,
  MAX_FILES_IN_RECORD,
  SNAPSHOT_REF_PREFIX,
  emptyStats,
  type Snapshot,
  type SnapshotRecord,
  type SnapshotTrigger,
} from './catalog.js';
import { RecodeError } from './errors.js';
import { isNotFound } from './fsutil.js';
import { splitNul } from './git.js';
import { snapshotIdFor } from './ids.js';
import { readMeta, setWarning, writeMeta, type RepoMeta } from './meta.js';
import type { Project } from './project.js';
import type { Runtime } from './runtime.js';
import { emptyTree, ensureStore, storeGit, storeText, syncExcludes, withRepoLock } from './store.js';
import { diffTrees, fillLineCounts, summarize } from './stats.js';
import { readUserRepo, reflogEntriesSince, reflogSize, treeOfCommit } from './userrepo.js';

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface CreateSnapshotOptions {
  trigger: SnapshotTrigger;
  message?: string;
  /** Pin the resulting snapshot with this reason (pre-restore snapshots are pinned). */
  pinReason?: string;
  /** Do not run the auto-pin rules (used right after a restore). */
  skipAnomaly?: boolean;
}

export interface CreateSnapshotResult {
  /** False when the work tree equals the latest snapshot; `snapshot` is then that one. */
  created: boolean;
  snapshot: Snapshot;
  previous?: Snapshot;
  findings: AnomalyFinding[];
  alert?: Alert;
  skipped: SkippedFile[];
}

const STAT_CONCURRENCY = 64;

/**
 * Stages the whole work tree into the store's private index and writes a tree.
 * Honors .gitignore; skips oversized files, nested repositories and unreadable
 * (e.g. locked) files instead of failing the whole snapshot.
 */
export async function stageWorkTree(rt: Runtime, project: Project): Promise<{ tree: string; skipped: SkippedFile[] }> {
  const listed = splitNul(
    (await storeGit(project, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout,
  );
  const skipped: SkippedFile[] = [];
  const excluded: string[] = [];
  const files: string[] = [];
  for (const p of new Set(listed)) {
    if (p.endsWith('/')) {
      // git lists an embedded repository as a directory entry.
      excluded.push(p.slice(0, -1));
      skipped.push({ path: p.slice(0, -1), reason: 'repo git lồng bên trong (không được snapshot)' });
    } else {
      files.push(p);
    }
  }

  const limit = rt.config.snapshot.maxFileSizeBytes;
  for (let i = 0; i < files.length; i += STAT_CONCURRENCY) {
    const batch = files.slice(i, i + STAT_CONCURRENCY);
    const sizes = await Promise.all(
      batch.map(async (p) => {
        try {
          return (await lstat(join(project.root, p))).size;
        } catch (err) {
          if (isNotFound(err)) return 0;
          throw err;
        }
      }),
    );
    sizes.forEach((size, j) => {
      if (size > limit) {
        const p = batch[j]!;
        excluded.push(p);
        skipped.push({ path: p, reason: `lớn hơn ${Math.round(limit / 1024 / 1024)}MB (${(size / 1024 / 1024).toFixed(1)}MB)` });
      }
    });
  }

  const pathspecArgs = ['--pathspec-from-file=-', '--pathspec-file-nul'];
  if (excluded.length > 0) {
    // Make sure an older, smaller version of an excluded file does not linger in the index.
    await storeGit(project, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', ...pathspecArgs], {
      input: excluded.map((p) => `:(literal)${p}\0`).join(''),
    });
  }
  const addInput = excluded.length > 0 ? ['.', ...excluded.map((p) => `:(exclude,literal)${p}`)].join('\0') + '\0' : undefined;
  const add = await storeGit(project, ['add', '-A', '--ignore-errors', ...(addInput ? pathspecArgs : [])], {
    input: addInput,
    allowFailure: true,
  });
  if (add.code !== 0) {
    const unreadable = [...add.stderr.matchAll(/unable to index file '?(.+?)'?$/gm)].map((m) => m[1]!);
    if (/^fatal:/m.test(add.stderr) || unreadable.length === 0) {
      throw new RecodeError(`Không stage được work tree: ${add.stderr.trim()}`, 'STAGE_FAILED');
    }
    for (const p of unreadable) skipped.push({ path: p, reason: 'không đọc được (file đang bị khóa?)' });
  }
  const tree = (await storeText(project, ['write-tree'])).trim();
  return { tree, skipped };
}

async function countIndexFiles(project: Project): Promise<number> {
  return splitNul((await storeGit(project, ['ls-files', '-z'])).stdout).length;
}

export function pinInMeta(meta: RepoMeta, id: string, reason: string, now: number): void {
  const state = (meta.snapshots[id] ??= {});
  if (state.pinned) {
    if (state.pinReason && !state.pinReason.includes(reason)) state.pinReason = `${state.pinReason}; ${reason}`;
    return;
  }
  state.pinned = true;
  state.pinReason = reason;
  state.pinnedAt = new Date(now).toISOString();
}

async function previousWasDirty(project: Project, prev: Snapshot): Promise<boolean> {
  if (!prev.baseCommit) return prev.tree !== (await emptyTree(project));
  const committed = await treeOfCommit(project.root, prev.baseCommit);
  return committed !== prev.tree;
}

export async function createSnapshotLocked(
  rt: Runtime,
  project: Project,
  opts: CreateSnapshotOptions,
): Promise<CreateSnapshotResult> {
  if (!existsSync(project.root)) {
    throw new RecodeError(`Thư mục project không tồn tại: ${project.root}`, 'PROJECT_MISSING');
  }
  await ensureStore(rt, project);
  const user = await readUserRepo(project.root);
  await syncExcludes(rt, project, user.commonDir);
  const { tree, skipped } = await stageWorkTree(rt, project);

  const meta = await readMeta(project);
  const snapshots = await listSnapshots(project, meta);
  const prev = snapshots.at(-1);
  const now = rt.now();

  setWarning(
    meta,
    'skipped-files',
    skipped.length > 0 ? `Bỏ qua ${skipped.length} file: ${skipped.slice(0, 3).map((s) => `${s.path} (${s.reason})`).join(', ')}` : undefined,
    now,
  );

  if (prev && prev.tree === tree) {
    if (opts.pinReason) pinInMeta(meta, prev.id, opts.pinReason, now);
    await writeMeta(project, meta);
    const fresh = (await listSnapshots(project, meta)).find((s) => s.id === prev.id)!;
    return { created: false, snapshot: fresh, previous: prev, findings: [], skipped };
  }

  const changes = prev ? await diffTrees(project, prev.tree, tree) : [];
  const findings: AnomalyFinding[] = [];
  if (prev && !opts.skipAnomaly) {
    const a = rt.config.anomaly;
    await fillLineCounts(project, prev.tree, changes, {
      minNetDeleted: Math.floor(a.fileShrinkMinLines * a.fileShrinkRatio),
      needAllWhenTotalAtLeast: a.totalDeleteMinLines,
    });
    findings.push(...detectContentAnomalies(changes, a));
    if (user.gitDir && prev.reflogSize !== undefined) {
      const entries = await reflogEntriesSince(user.gitDir, prev.reflogSize, prev.ts);
      if (entries.length > 0) {
        const head = detectHeadAnomaly(entries, await previousWasDirty(project, prev), a);
        if (head) findings.push(head);
      }
    }
  }

  const stats = prev ? summarize(changes) : { ...emptyStats(), filesAdded: await countIndexFiles(project) };
  const id = snapshotIdFor(now, new Set(snapshots.map((s) => s.id)));
  const record: SnapshotRecord = {
    recode: 1,
    id,
    timestamp: new Date(now).toISOString(),
    ts: now,
    branch: user.branch ?? null,
    baseCommit: user.head ?? null,
    trigger: opts.trigger,
    ...(opts.message ? { message: opts.message } : {}),
    previousId: prev?.id ?? null,
    ...(prev ? {} : { baseline: true }),
    stats,
    files: changes.slice(0, MAX_FILES_IN_RECORD),
    ...(changes.length > MAX_FILES_IN_RECORD ? { filesTruncated: true } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
    pinned: Boolean(opts.pinReason),
    pinReason: opts.pinReason ?? null,
    reflogSize: await reflogSize(user.gitDir),
  };

  const commit = (
    await storeText(project, ['commit-tree', '--no-gpg-sign', tree], { workTree: null, input: JSON.stringify(record) })
  ).trim();
  // Empty old-value: fail instead of overwriting if the ref somehow exists already.
  await storeGit(project, ['update-ref', `${SNAPSHOT_REF_PREFIX}${id}`, commit, ''], { workTree: null });

  if (opts.pinReason) pinInMeta(meta, id, opts.pinReason, now);
  let alert: Alert | undefined;
  if (prev && findings.length > 0) {
    const reasons = findings.map((f) => f.message);
    pinInMeta(meta, prev.id, reasons.join('; '), now);
    alert = await addAlert(rt, project, {
      goodSnapshotId: prev.id,
      badSnapshotId: id,
      trigger: opts.trigger,
      reasons,
    });
  }
  await writeMeta(project, meta);

  const all = await listSnapshots(project, meta);
  return {
    created: true,
    snapshot: all.find((s) => s.id === id)!,
    previous: prev ? all.find((s) => s.id === prev.id) : undefined,
    findings,
    alert,
    skipped,
  };
}

export function createSnapshot(rt: Runtime, project: Project, opts: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
  return withRepoLock(project, () => createSnapshotLocked(rt, project, opts));
}
