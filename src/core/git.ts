import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { RecodeError } from './errors.js';

/**
 * Variables that would redirect git to another repository. They must never leak in from
 * the caller's environment (e.g. when recode runs inside a git hook) — every call sets
 * exactly what it needs.
 */
const REPO_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
];

export interface GitRunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  input?: string | Buffer;
  /** Do not throw on non-zero exit; the caller inspects `code`. */
  allowFailure?: boolean;
}

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export function gitBinary(): string {
  return process.env.RECODE_GIT || 'git';
}

export function buildGitEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of REPO_ENV_VARS) delete env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  // Never take optional locks (e.g. refreshing the user's index during read commands).
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Runs git with an argument array (never through a shell), so paths with spaces,
 * Vietnamese characters or shell metacharacters are passed verbatim on every platform.
 */
export function runGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
  const fullArgs = ['-c', 'core.quotePath=false', '--no-pager', ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary(), fullArgs, {
      cwd: opts.cwd,
      env: buildGitEnv(opts.env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' && !existsSync(opts.cwd)) {
        reject(new RecodeError(`Thư mục không tồn tại: ${opts.cwd}`, 'CWD_MISSING'));
      } else if (e.code === 'ENOENT') {
        reject(new RecodeError('Không tìm thấy git trong PATH. Recode cần Git đã được cài đặt.', 'GIT_NOT_FOUND'));
      } else {
        reject(e);
      }
    });
    child.on('close', (code) => {
      const result: GitResult = {
        code: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      };
      if (result.code !== 0 && !opts.allowFailure) {
        reject(
          new RecodeError(
            `git ${args.join(' ')} thất bại (exit ${result.code}): ${result.stderr.trim()}`,
            'GIT_FAILED',
          ),
        );
        return;
      }
      resolve(result);
    });
    child.stdin.on('error', () => {
      // git may exit before consuming stdin; the exit code reports the real problem.
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function gitText(args: string[], opts: GitRunOptions): Promise<string> {
  const res = await runGit(args, opts);
  return res.stdout.toString('utf8');
}

/** Splits NUL-terminated git output (-z). */
export function splitNul(buf: Buffer | string): string[] {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  const parts = text.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export async function gitVersion(cwd: string): Promise<[number, number, number]> {
  const text = await gitText(['--version'], { cwd });
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) throw new RecodeError(`Không đọc được phiên bản git: ${text}`, 'GIT_VERSION');
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}
