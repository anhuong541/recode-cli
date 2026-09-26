import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { configPath, type DeepPartial, type RecodeConfig } from '../../src/core/config.js';
import { writeJsonAtomic } from '../../src/core/fsutil.js';
import { canonicalPath } from '../../src/core/paths.js';
import { projectFor, type Project } from '../../src/core/project.js';
import { createRuntime, type Runtime } from '../../src/core/runtime.js';
import { main } from '../../src/cli/main.js';

/** Controllable clock: `advance()` simulates hours/days passing for retention tests. */
export class FakeClock {
  constructor(public t = Date.now()) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface Sandbox {
  /** Project root — deliberately contains Vietnamese characters and spaces (spec 7A.10). */
  root: string;
  home: string;
  base: string;
  rt: Runtime;
  project: Project;
  clock?: FakeClock;
  git(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
  read(path: string): Buffer;
  sha(path: string): string;
  cleanup(): void;
}

export interface SandboxOptions {
  config?: DeepPartial<RecodeConfig>;
  clock?: FakeClock;
  /** Create an initial commit (default true). */
  commit?: boolean;
  files?: Record<string, string>;
}

export const PROJECT_DIR_NAME = 'dự án có dấu & khoảng trắng';

export function runGitSync(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function makeSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const base = canonicalPath(mkdtempSync(join(tmpdir(), 'recode test ')));
  const root = join(base, PROJECT_DIR_NAME);
  const home = join(base, 'recode-home');
  mkdirSync(root, { recursive: true });
  const rt = await createRuntime({ home, now: opts.clock?.now, config: opts.config });
  // Persist overrides so CLI invocations (which load config.json) see the same settings.
  if (opts.config) await writeJsonAtomic(configPath(home), rt.config);
  const project = projectFor(rt, canonicalPath(root));

  const sb: Sandbox = {
    root,
    home,
    base,
    rt,
    project,
    clock: opts.clock,
    git: (...args) => runGitSync(root, args),
    write(path, content) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    read: (path) => readFileSync(join(root, path)),
    sha: (path) => sha256(readFileSync(join(root, path))),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
  sb.git('init', '-q');
  for (const [p, c] of Object.entries(opts.files ?? {})) sb.write(p, c);
  if (opts.commit !== false) {
    sb.git('add', '-A');
    sb.git('commit', '-q', '--allow-empty', '-m', 'initial');
  }
  return sb;
}

/** sha256 of every file under dir (excluding .git), keyed by POSIX relative path. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join('/')] = sha256(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

export function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  raw: Buffer;
}

export async function cli(
  sb: Sandbox,
  argv: string[],
  opts: { cwd?: string; confirm?: boolean[]; tty?: boolean } = {},
): Promise<CliRun> {
  const out: Buffer[] = [];
  let err = '';
  const answers = [...(opts.confirm ?? [])];
  const code = await main(argv, {
    stdout: (c) => out.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    stderr: (c) => (err += c),
    isTTY: opts.tty ?? false,
    cwd: opts.cwd ?? sb.root,
    confirm: async () => answers.shift() ?? false,
    runtime: { home: sb.home, now: sb.clock?.now },
  });
  const raw = Buffer.concat(out);
  return { code, stdout: raw.toString('utf8'), stderr: err, raw };
}

export async function cliJson<T = any>(sb: Sandbox, argv: string[], opts?: { cwd?: string }): Promise<T> {
  // Options must precede `--`, everything after it is a path.
  const sepIdx = argv.indexOf('--');
  const withJson = sepIdx < 0 ? [...argv, '--json'] : [...argv.slice(0, sepIdx), '--json', ...argv.slice(sepIdx)];
  const res = await cli(sb, withJson, opts);
  if (res.code !== 0) throw new Error(`recode ${argv.join(' ')} exited ${res.code}: ${res.stderr}`);
  return JSON.parse(res.stdout) as T;
}
