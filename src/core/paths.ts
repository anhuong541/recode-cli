import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RecodeError } from './errors.js';

export function defaultRecodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RECODE_HOME;
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), '.recode');
}

function stripWin32Prefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

/**
 * Absolute, symlink-resolved path. Works for paths that no longer exist (e.g. a project
 * deleted with rm -rf): the nearest existing ancestor is resolved and the rest re-appended,
 * so the same project always maps to the same repo id.
 */
export function canonicalPath(p: string, cwd: string = process.cwd()): string {
  const abs = resolve(cwd, p);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = stripWin32Prefix(realpathSync.native(current));
      const full = missing.length > 0 ? join(real, ...missing.reverse()) : real;
      return trimTrailingSep(full.normalize('NFC'));
    } catch {
      const parent = dirname(current);
      if (parent === current) return trimTrailingSep(abs.normalize('NFC'));
      missing.push(basename(current));
      current = parent;
    }
  }
}

function trimTrailingSep(p: string): string {
  if (p.length > 1 && (p.endsWith('/') || p.endsWith('\\')) && !/^[A-Za-z]:[\\/]$/.test(p)) {
    return p.slice(0, -1);
  }
  return p;
}

/** Key used for hashing: Windows paths are case-insensitive and may use either separator. */
export function projectKey(canonical: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return canonical.replace(/\//g, '\\').toLowerCase();
  return canonical;
}

export function repoIdFor(canonical: string, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256').update(projectKey(canonical, platform), 'utf8').digest('hex').slice(0, 16);
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Converts a user-supplied path into a repo-relative POSIX path (the form git uses). */
export function toRepoPath(root: string, input: string, cwd: string): string {
  const cwdCanon = canonicalPath(cwd);
  const base = isInside(root, cwdCanon) ? cwdCanon : root;
  const resolved = resolve(base, input);
  // Resolve the parent only: the last component may be a symlink that must not be followed.
  const abs = resolved === root ? root : join(canonicalPath(dirname(resolved)), basename(resolved));
  if (!isInside(root, abs)) {
    throw new RecodeError(`Đường dẫn nằm ngoài project: ${input}`, 'PATH_OUTSIDE_PROJECT');
  }
  return relative(root, abs).split(sep).join('/') || '.';
}

/**
 * Paths where native file events are known to be unreliable, so polling is used instead.
 * Returns a human readable reason, or undefined when native events should be fine.
 */
export function unreliableEventsReason(root: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const lower = root.toLowerCase();
  if (platform === 'win32') {
    if (lower.startsWith('\\\\wsl$\\') || lower.startsWith('\\\\wsl.localhost\\')) {
      return 'đường dẫn WSL (\\\\wsl$) từ Windows';
    }
    if (lower.startsWith('\\\\')) return 'ổ mạng (UNC)';
  }
  if (platform === 'linux' && /^\/mnt\/[a-z]\//.test(lower) && process.env.WSL_DISTRO_NAME) {
    return 'ổ Windows mount trong WSL (/mnt/*)';
  }
  return undefined;
}
