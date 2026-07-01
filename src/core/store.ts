import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFound } from './fsutil.js';
import { withLock } from './lock.js';
import { runGit, type GitResult, type GitRunOptions } from './git.js';
import { readMeta, writeMeta } from './meta.js';
import type { Project } from './project.js';
import type { Runtime } from './runtime.js';
import { readUserRepo } from './userrepo.js';

/** Built-in ignores (spec 4B), on top of the project's own .gitignore files. */
export const DEFAULT_IGNORES = [
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.turbo/',
  '.cache/',
  'target/',
  '*.log',
];

/**
 * Byte-exact storage: disable every content transformation git could apply when reading
 * the work tree or writing it back (eol conversion, clean/smudge filters such as LFS,
 * $Id$ expansion, working-tree-encoding). $GIT_DIR/info/attributes beats .gitattributes.
 */
const STORE_ATTRIBUTES = '* -text -crlf -eol -filter -ident -working-tree-encoding\n';

const STORE_CONFIG: [string, string][] = [
  ['core.autocrlf', 'false'],
  ['core.safecrlf', 'false'],
  ['core.precomposeUnicode', 'true'],
  ['core.quotePath', 'false'],
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['core.logAllRefUpdates', 'false'],
  ['gc.auto', '0'],
  ['gc.autoDetach', 'false'],
  ['commit.gpgSign', 'false'],
];

/** Settings describing the file system of the work tree; copied from the user's repo. */
const INHERITED_CONFIG = ['core.ignorecase', 'core.symlinks', 'core.filemode'];

const IDENTITY = {
  GIT_AUTHOR_NAME: 'recode',
  GIT_AUTHOR_EMAIL: 'recode@localhost',
  GIT_COMMITTER_NAME: 'recode',
  GIT_COMMITTER_EMAIL: 'recode@localhost',
};

export interface StoreGitOptions {
  /** Work tree to operate on; defaults to the project root. `null` = no work tree. */
  workTree?: string | null;
  indexFile?: string;
  /** Extra object directories (the user's .git/objects) for diffs against their commits. */
  alternates?: string[];
  input?: string | Buffer;
  allowFailure?: boolean;
  env?: Record<string, string | undefined>;
}

/** Runs git against the shadow store, never against the user's .git or index. */
export function storeGit(project: Project, args: string[], opts: StoreGitOptions = {}): Promise<GitResult> {
  const workTree = opts.workTree === undefined ? project.root : opts.workTree;
  const env: Record<string, string | undefined> = {
    ...IDENTITY,
    GIT_DIR: project.storeDir,
    GIT_INDEX_FILE: opts.indexFile ?? project.indexFile,
    GIT_WORK_TREE: workTree ?? undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES:
      opts.alternates && opts.alternates.length > 0 ? opts.alternates.join(process.platform === 'win32' ? ';' : ':') : undefined,
    ...opts.env,
  };
  const runOpts: GitRunOptions = {
    // git resolves relative paths against cwd, so work-tree commands run from its root.
    cwd: workTree && existsSync(workTree) ? workTree : project.repoDir,
    env,
    input: opts.input,
    allowFailure: opts.allowFailure,
  };
  return runGit(args, runOpts);
}

export async function storeText(project: Project, args: string[], opts: StoreGitOptions = {}): Promise<string> {
  return (await storeGit(project, args, opts)).stdout.toString('utf8');
}

/** Creates ~/.recode/repos/<id>/ with a bare store and meta.json if needed. Idempotent. */
export async function ensureStore(rt: Runtime, project: Project): Promise<void> {
  await mkdir(project.repoDir, { recursive: true });
  if (!existsSync(join(project.storeDir, 'HEAD'))) {
    await runGit(['init', '--bare', '-q', project.storeDir], { cwd: project.repoDir });
    for (const [key, value] of STORE_CONFIG) {
      await storeGit(project, ['config', key, value], { workTree: null });
    }
    if (existsSync(project.root)) {
      for (const key of INHERITED_CONFIG) {
        const res = await runGit(['config', '--get', key], { cwd: project.root, allowFailure: true });
        const value = res.stdout.toString('utf8').trim();
        if (res.code === 0 && value) await storeGit(project, ['config', key, value], { workTree: null });
      }
    }
    await mkdir(join(project.storeDir, 'info'), { recursive: true });
    await writeFile(join(project.storeDir, 'info', 'attributes'), STORE_ATTRIBUTES, 'utf8');
  }
  const meta = await readMeta(project);
  if (!meta.projectPath) {
    meta.projectPath = project.root;
    meta.repoId = project.repoId;
    meta.createdAt = new Date(rt.now()).toISOString();
    await writeMeta(project, meta);
  }
}

/**
 * Store exclude file = built-in defaults + config.extraIgnore + the project's own
 * .git/info/exclude (which git would not see, because GIT_DIR points at the store).
 */
export async function syncExcludes(rt: Runtime, project: Project, userGitDir: string | undefined): Promise<void> {
  const parts = ['# Managed by recode — regenerated on every snapshot', ...DEFAULT_IGNORES, ...rt.config.snapshot.extraIgnore];
  if (userGitDir) {
    try {
      const own = await readFile(join(userGitDir, 'info', 'exclude'), 'utf8');
      parts.push('# from project .git/info/exclude', own.trimEnd());
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  const content = parts.join('\n') + '\n';
  const file = join(project.storeDir, 'info', 'exclude');
  let current: string | undefined;
  try {
    current = await readFile(file, 'utf8');
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (current !== content) {
    await mkdir(join(project.storeDir, 'info'), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
}

export async function userObjectDirs(project: Project): Promise<string[]> {
  const repo = await readUserRepo(project.root);
  return repo.commonDir ? [join(repo.commonDir, 'objects')] : [];
}

let emptyTreeCache: string | undefined;
export async function emptyTree(project: Project): Promise<string> {
  if (!emptyTreeCache) {
    emptyTreeCache = (await storeText(project, ['mktree'], { workTree: null, input: '' })).trim();
  }
  return emptyTreeCache;
}

/** Serialises all mutations of one project's shadow repo (see lock.ts). */
export async function withRepoLock<T>(project: Project, fn: () => Promise<T>): Promise<T> {
  await mkdir(project.repoDir, { recursive: true });
  return withLock(project.lockFile, fn);
}
