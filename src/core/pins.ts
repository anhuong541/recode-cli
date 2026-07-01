import { findSnapshot, listSnapshots, type Snapshot } from './catalog.js';
import { readMeta, writeMeta } from './meta.js';
import type { Project } from './project.js';
import type { Runtime } from './runtime.js';
import { pinInMeta } from './snapshot.js';
import { withRepoLock } from './store.js';

export async function pinSnapshot(rt: Runtime, project: Project, input: string, reason = 'pin thủ công'): Promise<Snapshot> {
  return withRepoLock(project, async () => {
    const meta = await readMeta(project);
    const target = findSnapshot(await listSnapshots(project, meta), input);
    pinInMeta(meta, target.id, reason, rt.now());
    await writeMeta(project, meta);
    return (await listSnapshots(project, meta)).find((s) => s.id === target.id)!;
  });
}

export async function unpinSnapshot(project: Project, input: string): Promise<Snapshot> {
  return withRepoLock(project, async () => {
    const meta = await readMeta(project);
    const target = findSnapshot(await listSnapshots(project, meta), input);
    meta.snapshots[target.id] = { ...meta.snapshots[target.id], pinned: false, pinReason: undefined, pinnedAt: undefined };
    await writeMeta(project, meta);
    return (await listSnapshots(project, meta)).find((s) => s.id === target.id)!;
  });
}
