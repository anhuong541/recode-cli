import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { Project } from './project.js';

/** Mutable per-snapshot state. Snapshot commits themselves are immutable. */
export interface SnapshotState {
  pinned?: boolean;
  pinReason?: string;
  pinnedAt?: string;
  /** Set while the snapshot's tree equals the tree of a commit in the user's history. */
  coveredAt?: string;
  coveredBy?: string;
}

export interface RepoWarning {
  type: 'size' | 'skipped-files' | 'poll' | 'other';
  message: string;
  at: string;
}

export interface RepoMeta {
  schemaVersion: 1;
  projectPath?: string;
  repoId?: string;
  createdAt?: string;
  lastGcAt?: string;
  snapshots: Record<string, SnapshotState>;
  warnings: RepoWarning[];
}

export async function readMeta(project: Project): Promise<RepoMeta> {
  const raw = await readJsonFile<Partial<RepoMeta>>(project.metaFile);
  return {
    schemaVersion: 1,
    ...raw,
    snapshots: raw?.snapshots ?? {},
    warnings: raw?.warnings ?? [],
  };
}

export async function writeMeta(project: Project, meta: RepoMeta): Promise<void> {
  await writeJsonAtomic(project.metaFile, meta);
}

/** Replaces the warning of the same type (warnings describe current state, not history). */
export function setWarning(meta: RepoMeta, type: RepoWarning['type'], message: string | undefined, now: number): void {
  meta.warnings = meta.warnings.filter((w) => w.type !== type);
  if (message) meta.warnings.push({ type, message, at: new Date(now).toISOString() });
}
