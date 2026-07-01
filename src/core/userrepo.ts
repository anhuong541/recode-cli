import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFound } from './fsutil.js';
import { runGit, splitNul } from './git.js';

/**
 * Read-only access to the user's own repository. Every call runs with GIT_OPTIONAL_LOCKS=0
 * (see buildGitEnv) and nothing here writes to .git or the user's index.
 */
export interface UserRepoState {
  exists: boolean;
  gitDir?: string;
  commonDir?: string;
  head?: string;
  branch?: string;
}

export async function readUserRepo(root: string): Promise<UserRepoState> {
  if (!existsSync(root)) return { exists: false };
  const dirs = await runGit(
    ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
    { cwd: root, allowFailure: true },
  );
  if (dirs.code !== 0) return { exists: false };
  const [gitDir, commonDir] = dirs.stdout.toString('utf8').trim().split(/\r?\n/);
  const [head, branch] = await Promise.all([
    runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: root, allowFailure: true }),
    runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, allowFailure: true }),
  ]);
  return {
    exists: true,
    gitDir,
    commonDir,
    head: head.code === 0 ? head.stdout.toString('utf8').trim() : undefined,
    branch: branch.code === 0 ? branch.stdout.toString('utf8').trim() : undefined,
  };
}

export async function treeOfCommit(root: string, commit: string): Promise<string | undefined> {
  const res = await runGit(['rev-parse', '-q', '--verify', `${commit}^{tree}`], { cwd: root, allowFailure: true });
  return res.code === 0 ? res.stdout.toString('utf8').trim() : undefined;
}

export interface HeadInfo {
  short: string;
  subject: string;
  time: number;
}

export async function headInfo(root: string): Promise<HeadInfo | undefined> {
  const res = await runGit(['log', '-1', '--format=%h%x00%s%x00%ct', 'HEAD'], { cwd: root, allowFailure: true });
  if (res.code !== 0) return undefined;
  const [short, subject, ct] = splitNul(res.stdout.toString('utf8').trim());
  if (!short) return undefined;
  return { short, subject: subject ?? '', time: Number(ct) * 1000 };
}

/** Tree ids of every commit reachable from any ref, committed since `sinceMs`. */
export async function recentCommitTrees(root: string, sinceMs: number): Promise<Set<string>> {
  const since = new Date(sinceMs).toISOString();
  const res = await runGit(['log', '--all', `--since=${since}`, '--format=%T'], { cwd: root, allowFailure: true });
  const out = new Set<string>();
  if (res.code !== 0) return out;
  for (const line of res.stdout.toString('utf8').split('\n')) {
    const t = line.trim();
    if (t) out.add(t);
  }
  return out;
}

export interface ReflogEntry {
  oldOid: string;
  newOid: string;
  time: number;
  message: string;
}

export function reflogFile(gitDir: string): string {
  return join(gitDir, 'logs', 'HEAD');
}

export async function reflogSize(gitDir: string | undefined): Promise<number | undefined> {
  if (!gitDir) return undefined;
  try {
    return (await stat(reflogFile(gitDir))).size;
  } catch (err) {
    if (isNotFound(err)) return 0;
    throw err;
  }
}

/**
 * HEAD reflog entries appended after byte `offset`. If the reflog shrank (expired /
 * rewritten), everything newer than `sinceMs` is returned instead.
 */
export async function reflogEntriesSince(gitDir: string, offset: number, sinceMs: number): Promise<ReflogEntry[]> {
  let handle;
  try {
    handle = await open(reflogFile(gitDir), 'r');
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const shrunk = size < offset;
    const start = shrunk ? 0 : offset;
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const entries = parseReflog(buf.toString('utf8'));
    return shrunk ? entries.filter((e) => e.time >= Math.floor(sinceMs / 1000) * 1000) : entries;
  } finally {
    await handle.close();
  }
}

export function parseReflog(text: string): ReflogEntry[] {
  const out: ReflogEntry[] = [];
  for (const line of text.split('\n')) {
    // <old> <new> <name> <<email>> <unix-time> <tz>\t<message>
    const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .*? (\d+) [+-]\d{4}\t(.*)$/.exec(line);
    if (!m) continue;
    out.push({ oldOid: m[1]!, newOid: m[2]!, time: Number(m[3]) * 1000, message: m[4]! });
  }
  return out;
}

/** reset / checkout (branch switch) entries: HEAD moved in a way that rewrites the work tree. */
export function isDestructiveHeadMove(entry: ReflogEntry): boolean {
  return /^(reset|checkout|switch)\b/.test(entry.message);
}
