import { findSnapshot, listSnapshots, type FileChange, type Snapshot } from './catalog.js';
import { RecodeError } from './errors.js';
import type { Project } from './project.js';
import type { Runtime } from './runtime.js';
import { stageWorkTree } from './snapshot.js';
import { diffTrees } from './stats.js';
import { ensureStore, storeGit, syncExcludes, userObjectDirs, withRepoLock } from './store.js';
import { readUserRepo } from './userrepo.js';

export type DiffSide =
  | { kind: 'snapshot'; id: string; tree: string }
  | { kind: 'current'; tree: string }
  | { kind: 'HEAD'; commit: string; tree: string };

export interface DiffResult {
  from: DiffSide;
  to: DiffSide;
  files: FileChange[];
  patch: string;
}

export interface DiffOptions {
  snapshot: string;
  /** 'current' (default), 'HEAD' or another snapshot id. */
  against?: string;
  paths?: string[];
  color?: boolean;
}

async function currentTree(rt: Runtime, project: Project): Promise<string> {
  return withRepoLock(project, async () => {
    await ensureStore(rt, project);
    const user = await readUserRepo(project.root);
    await syncExcludes(rt, project, user.commonDir);
    return (await stageWorkTree(rt, project)).tree;
  });
}

/** Diff from a snapshot to the current work tree / HEAD / another snapshot. */
export async function diffSnapshot(rt: Runtime, project: Project, opts: DiffOptions): Promise<DiffResult> {
  const snapshots = await listSnapshots(project);
  const base = findSnapshot(snapshots, opts.snapshot);
  const from: DiffSide = { kind: 'snapshot', id: base.id, tree: base.tree };
  const against = opts.against ?? 'current';
  let to: DiffSide;
  let alternates: string[] | undefined;

  if (against === 'current') {
    to = { kind: 'current', tree: await currentTree(rt, project) };
  } else if (against.toUpperCase() === 'HEAD') {
    const user = await readUserRepo(project.root);
    if (!user.head) throw new RecodeError('Repo không có HEAD (chưa có commit hoặc .git đã bị xóa).', 'NO_HEAD');
    alternates = await userObjectDirs(project);
    const tree = (
      await storeGit(project, ['rev-parse', `${user.head}^{tree}`], { workTree: null, alternates })
    ).stdout
      .toString('utf8')
      .trim();
    to = { kind: 'HEAD', commit: user.head, tree };
  } else {
    const other = findSnapshot(snapshots, against);
    to = { kind: 'snapshot', id: other.id, tree: other.tree };
  }

  const paths = opts.paths ?? [];
  const files = await diffTrees(project, from.tree, to.tree, { paths, alternates });
  const patch = (
    await storeGit(
      project,
      [
        'diff-tree',
        '-r',
        '-p',
        '-M',
        '--no-ext-diff',
        '--no-textconv',
        opts.color ? '--color=always' : '--no-color',
        from.tree,
        to.tree,
        '--',
        ...paths,
      ],
      { workTree: null, alternates, env: { GIT_LITERAL_PATHSPECS: '1' } },
    )
  ).stdout.toString('utf8');
  return { from, to, files, patch };
}

export async function getSnapshot(project: Project, input: string): Promise<Snapshot> {
  return findSnapshot(await listSnapshots(project), input);
}

/** Exact bytes of a file at a snapshot. */
export async function readSnapshotFile(project: Project, input: string, path: string): Promise<{ snapshot: Snapshot; content: Buffer }> {
  const snapshot = await getSnapshot(project, input);
  const res = await storeGit(project, ['cat-file', 'blob', `${snapshot.commit}:${path}`], {
    workTree: null,
    allowFailure: true,
  });
  if (res.code !== 0) {
    throw new RecodeError(`File "${path}" không có trong snapshot ${snapshot.id}.`, 'PATH_NOT_IN_SNAPSHOT');
  }
  return { snapshot, content: res.stdout };
}
