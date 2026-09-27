import { existsSync } from 'node:fs';
import { pruneAlerts } from './alerts.js';
import { listSnapshots, SNAPSHOT_REF_PREFIX } from './catalog.js';
import { readMeta, setWarning, writeMeta } from './meta.js';
import type { Project } from './project.js';
import { planRetention, type RetentionDecision } from './retention.js';
import type { Runtime } from './runtime.js';
import { storeGit, storeText, withRepoLock } from './store.js';
import { recentCommitTrees } from './userrepo.js';

export interface GcResult {
  dryRun: boolean;
  decisions: RetentionDecision[];
  deleted: string[];
  newlyCovered: string[];
  sizeBytes?: number;
  sizeWarning?: string;
}

const DAY = 86_400_000;

async function storeSizeBytes(project: Project): Promise<number> {
  const text = await storeText(project, ['count-objects', '-v'], { workTree: null });
  let kib = 0;
  for (const line of text.split('\n')) {
    const m = /^(size|size-pack|size-garbage):\s*(\d+)/.exec(line.trim());
    if (m) kib += Number(m[2]);
  }
  return kib * 1024;
}

/**
 * Marks snapshots covered by commits, applies the retention plan and prunes the store.
 * A snapshot is "covered" only while its exact tree is the tree of a commit reachable
 * in the user's repo; if that commit disappears (reset, .git deleted) the mark is dropped.
 */
export async function runGc(rt: Runtime, project: Project, opts: { dryRun?: boolean } = {}): Promise<GcResult> {
  const dryRun = Boolean(opts.dryRun);
  return withRepoLock(project, async () => {
    const now = rt.now();
    const meta = await readMeta(project);
    const snapshots = await listSnapshots(project, meta);
    const newlyCovered: string[] = [];

    if (snapshots.length > 0) {
      const repoPresent = existsSync(project.root);
      const trees = repoPresent ? await recentCommitTrees(project.root, snapshots[0]!.ts - DAY) : new Set<string>();
      for (const s of snapshots) {
        const state = (meta.snapshots[s.id] ??= {});
        if (trees.has(s.tree)) {
          if (!state.coveredAt) {
            state.coveredAt = new Date(now).toISOString();
            newlyCovered.push(s.id);
          }
        } else if (state.coveredAt) {
          delete state.coveredAt;
          delete state.coveredBy;
        }
      }
    }

    const decisions = planRetention(
      snapshots.map((s) => {
        const state = meta.snapshots[s.id] ?? {};
        return {
          id: s.id,
          ts: s.ts,
          pinned: s.pinned,
          pinnedAt: s.pinnedAt ? Date.parse(s.pinnedAt) : undefined,
          coveredAt: state.coveredAt ? Date.parse(state.coveredAt) : undefined,
        };
      }),
      now,
      rt.config.retention,
    );
    const deleted = decisions.filter((d) => !d.keep).map((d) => d.id);
    if (dryRun) return { dryRun, decisions, deleted, newlyCovered };

    if (deleted.length > 0) {
      await storeGit(project, ['update-ref', '--stdin'], {
        workTree: null,
        input: deleted.map((id) => `delete ${SNAPSHOT_REF_PREFIX}${id}\n`).join(''),
      });
      for (const id of deleted) delete meta.snapshots[id];
    }

    // Keep every blob referenced by the private index alive, otherwise a prune could drop
    // objects the next `git add` assumes are present (it skips unchanged files).
    if (existsSync(project.indexFile)) {
      const res = await storeGit(project, ['write-tree'], { workTree: null, allowFailure: true });
      const indexTree = res.stdout.toString('utf8').trim();
      if (res.code === 0 && indexTree) {
        await storeGit(project, ['update-ref', 'refs/recode/index-tree', indexTree], { workTree: null });
      }
    }
    await storeGit(project, ['pack-refs', '--all', '--prune'], { workTree: null });
    await storeGit(project, ['gc', '--prune=now', '--quiet'], { workTree: null });

    const sizeBytes = await storeSizeBytes(project);
    const limit = rt.config.retention.maxRepoSizeBytes;
    const sizeWarning =
      sizeBytes > limit
        ? `Dung lượng snapshot ${(sizeBytes / 1024 / 1024).toFixed(0)}MB vượt giới hạn ${(limit / 1024 / 1024).toFixed(0)}MB (bản pin không bị tự xóa).`
        : undefined;
    setWarning(meta, 'size', sizeWarning, now);
    meta.lastGcAt = new Date(now).toISOString();
    await writeMeta(project, meta);
    await pruneAlerts(rt, project, new Set(decisions.filter((d) => d.keep).map((d) => d.id)));
    return { dryRun, decisions, deleted, newlyCovered, sizeBytes, sizeWarning };
  });
}
