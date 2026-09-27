import { existsSync } from 'node:fs';
import { splitNul } from './git.js';
import { resolveSnapshotId } from './ids.js';
import { readMeta, type RepoMeta } from './meta.js';
import type { Project } from './project.js';
import { storeGit } from './store.js';

export const SNAPSHOT_REF_PREFIX = 'refs/recode/snaps/';

export type SnapshotTrigger = 'watch' | 'manual' | 'pre-restore' | 'agent-hook' | 'restore';

export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'T';
  oldPath?: string;
  added?: number;
  deleted?: number;
  binary?: boolean;
  oldLines?: number;
  newLines?: number;
}

export interface SnapshotStats {
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesRenamed: number;
  linesAdded: number;
  linesDeleted: number;
}

/** Immutable metadata, stored as JSON in the snapshot commit message. */
export interface SnapshotRecord {
  recode: 1;
  id: string;
  timestamp: string;
  ts: number;
  branch: string | null;
  baseCommit: string | null;
  trigger: SnapshotTrigger;
  message?: string;
  /** Logical predecessor (snapshot commits have no git parents, see README). */
  previousId: string | null;
  baseline?: boolean;
  stats: SnapshotStats;
  files: FileChange[];
  filesTruncated?: boolean;
  skipped?: { path: string; reason: string }[];
  pinned: boolean;
  pinReason: string | null;
  /** Size of the user's .git/logs/HEAD when the snapshot was taken. */
  reflogSize?: number;
}

export interface Snapshot extends SnapshotRecord {
  commit: string;
  tree: string;
  pinnedAt?: string;
  coveredAt?: string;
  coveredBy?: string;
}

export const MAX_FILES_IN_RECORD = 200;

export function emptyStats(): SnapshotStats {
  return { filesAdded: 0, filesModified: 0, filesDeleted: 0, filesRenamed: 0, linesAdded: 0, linesDeleted: 0 };
}

function applyState(record: SnapshotRecord, commit: string, tree: string, meta: RepoMeta): Snapshot {
  const state = meta.snapshots[record.id] ?? {};
  const pinned = state.pinned ?? record.pinned;
  return {
    ...record,
    commit,
    tree,
    pinned,
    pinReason: pinned ? (state.pinReason ?? record.pinReason) : null,
    pinnedAt: pinned ? (state.pinnedAt ?? record.timestamp) : undefined,
    coveredAt: state.coveredAt,
    coveredBy: state.coveredBy,
  };
}

/** All snapshots of a project, oldest first. */
export async function listSnapshots(project: Project, meta?: RepoMeta): Promise<Snapshot[]> {
  if (!existsSync(project.storeDir)) return [];
  const res = await storeGit(
    project,
    ['for-each-ref', '--format=%(refname:lstrip=3)%00%(objectname)%00%(tree)%00%(contents:subject)%00', SNAPSHOT_REF_PREFIX],
    { workTree: null, allowFailure: true },
  );
  if (res.code !== 0) return [];
  const m = meta ?? (await readMeta(project));
  const fields = splitNul(res.stdout);
  const out: Snapshot[] = [];
  // Records are "name\0oid\0tree\0subject\0\n"; strip the newline for-each-ref adds.
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const name = fields[i]!.replace(/^\n/, '');
    const commit = fields[i + 1]!;
    const tree = fields[i + 2]!;
    const subject = fields[i + 3]!;
    let record: SnapshotRecord;
    try {
      record = JSON.parse(subject) as SnapshotRecord;
    } catch {
      continue;
    }
    if (record.recode !== 1 || record.id !== name) continue;
    out.push(applyState(record, commit, tree, m));
  }
  out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return out;
}

export function findSnapshot(snapshots: readonly Snapshot[], input: string): Snapshot {
  const ids = snapshots.map((s) => s.id);
  const id = resolveSnapshotId(input, ids, snapshots.at(-1)?.id);
  return snapshots.find((s) => s.id === id)!;
}

export function describeStats(s: SnapshotStats): string {
  const files = s.filesAdded + s.filesModified + s.filesDeleted + s.filesRenamed;
  return `${files} file, +${s.linesAdded}/-${s.linesDeleted}`;
}
