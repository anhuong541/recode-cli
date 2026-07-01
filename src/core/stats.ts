import { emptyStats, type FileChange, type SnapshotStats } from './catalog.js';
import { splitNul } from './git.js';
import type { Project } from './project.js';
import { storeGit } from './store.js';

/** Changes between two trees in the store, with per-file line counts (numstat). */
export async function diffTrees(
  project: Project,
  oldTree: string,
  newTree: string,
  opts: { paths?: string[]; alternates?: string[] } = {},
): Promise<FileChange[]> {
  const run = (mode: string) =>
    storeGit(
      project,
      ['diff-tree', mode, '-r', '-z', '-M', '--no-ext-diff', '--no-textconv', oldTree, newTree, '--', ...(opts.paths ?? [])],
      { workTree: null, alternates: opts.alternates, env: { GIT_LITERAL_PATHSPECS: '1' } },
    );
  const [statusRes, numRes] = await Promise.all([run('--name-status'), run('--numstat')]);

  const changes = new Map<string, FileChange>();
  const st = splitNul(statusRes.stdout);
  for (let i = 0; i < st.length; ) {
    const code = st[i++]!;
    const kind = code[0] as FileChange['status'] | 'C' | 'U' | 'X';
    if (kind === 'R' || kind === 'C') {
      const oldPath = st[i++]!;
      const path = st[i++]!;
      changes.set(path, kind === 'R' ? { path, oldPath, status: 'R' } : { path, status: 'A' });
    } else {
      const path = st[i++]!;
      if (kind === 'A' || kind === 'M' || kind === 'D' || kind === 'T') changes.set(path, { path, status: kind });
      else changes.set(path, { path, status: 'M' });
    }
  }

  // numstat -z: "added\tdeleted\tpath\0" or, for renames, "added\tdeleted\t\0old\0new\0".
  const ns = splitNul(numRes.stdout);
  for (let i = 0; i < ns.length; ) {
    const head = ns[i++]!;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    let path = m[3]!;
    if (path === '') {
      i++; // old path
      path = ns[i++]!;
    }
    const change = changes.get(path);
    if (!change) continue;
    if (m[1] === '-' || m[2] === '-') {
      change.binary = true;
    } else {
      change.added = Number(m[1]);
      change.deleted = Number(m[2]);
    }
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function summarize(changes: readonly FileChange[]): SnapshotStats {
  const s = emptyStats();
  for (const c of changes) {
    if (c.status === 'A') s.filesAdded++;
    else if (c.status === 'D') s.filesDeleted++;
    else if (c.status === 'R') s.filesRenamed++;
    else s.filesModified++;
    s.linesAdded += c.added ?? 0;
    s.linesDeleted += c.deleted ?? 0;
  }
  return s;
}

export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

/** Line counts of `<tree>:<path>` blobs, read in one `git cat-file --batch` call. */
export async function blobLineCounts(project: Project, tree: string, paths: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const usable = paths.filter((p) => !p.includes('\n'));
  if (usable.length === 0) return out;
  const input = usable.map((p) => `${tree}:${p}\n`).join('');
  const res = await storeGit(project, ['cat-file', '--batch'], { workTree: null, input });
  const buf = res.stdout;
  let pos = 0;
  for (const path of usable) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) continue; // "<spec> missing"
    const size = Number(m[2]);
    if (m[1] === 'blob') out.set(path, countLines(buf.subarray(pos, pos + size)));
    pos += size + 1;
  }
  return out;
}

/**
 * Fills oldLines/newLines on the changes the anomaly rules need: files that lost more than
 * `minNetDeleted` lines, or every modified file when the whole snapshot lost enough lines.
 */
export async function fillLineCounts(
  project: Project,
  oldTree: string,
  changes: FileChange[],
  opts: { minNetDeleted: number; needAllWhenTotalAtLeast: number },
): Promise<void> {
  let totalNet = 0;
  for (const c of changes) totalNet += (c.deleted ?? 0) - (c.added ?? 0);
  const needAll = totalNet >= opts.needAllWhenTotalAtLeast;
  const wanted: FileChange[] = [];
  for (const c of changes) {
    if (c.binary || c.added === undefined || c.deleted === undefined) continue;
    if (c.status === 'A') {
      c.oldLines = 0;
      c.newLines = c.added;
    } else if (c.status === 'D') {
      c.oldLines = c.deleted;
      c.newLines = 0;
    } else if (needAll || c.deleted - c.added > opts.minNetDeleted) {
      wanted.push(c);
    }
  }
  if (wanted.length === 0) return;
  const counts = await blobLineCounts(project, oldTree, wanted.map((c) => c.oldPath ?? c.path));
  for (const c of wanted) {
    const old = counts.get(c.oldPath ?? c.path);
    if (old === undefined) continue;
    c.oldLines = old;
    c.newLines = old + c.added! - c.deleted!;
  }
}
