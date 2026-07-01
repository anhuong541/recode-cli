import { relative, sep } from 'node:path';
import type { WatchMode } from '../core/watchstate.js';

/** Directories never worth waking up for (spec 4B). `.git` is watched separately. */
export const IGNORED_DIRS = ['.git', 'node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.cache', 'target'];

export function isIgnoredEventPath(root: string, absPath: string): boolean {
  const rel = relative(root, absPath);
  if (rel === '' || rel.startsWith('..')) return true;
  const parts = rel.split(sep);
  if (parts.some((p) => IGNORED_DIRS.includes(p))) return true;
  return rel.endsWith('.log');
}

export interface FileEventSource {
  readonly mode: WatchMode;
  stop(): Promise<void>;
}

export type OnPaths = (absPaths: string[]) => void;
export type OnError = (err: Error) => void;

/** @parcel/watcher: native backend (ReadDirectoryChangesW / FSEvents / inotify). */
export async function startNativeSource(root: string, onPaths: OnPaths, onError: OnError): Promise<FileEventSource> {
  const mod = (await import('@parcel/watcher')) as typeof import('@parcel/watcher') & { default?: typeof import('@parcel/watcher') };
  const api = typeof mod.subscribe === 'function' ? mod : mod.default!;
  const ignore = IGNORED_DIRS.flatMap((d) => [d, `**/${d}/**`]);
  const sub = await api.subscribe(
    root,
    (err, events) => {
      if (err) {
        onError(err);
        return;
      }
      const paths = events.map((e) => e.path).filter((p) => !isIgnoredEventPath(root, p));
      if (paths.length > 0) onPaths(paths);
    },
    { ignore },
  );
  return {
    mode: 'native',
    stop: () => sub.unsubscribe(),
  };
}

/** chokidar fallback, used when the native addon cannot load on this machine. */
export async function startChokidarSource(root: string, onPaths: OnPaths, onError: OnError): Promise<FileEventSource> {
  const { watch } = await import('chokidar');
  const w = watch(root, {
    ignoreInitial: true,
    ignored: (p: string) => p !== root && isIgnoredEventPath(root, p),
    awaitWriteFinish: false,
  });
  w.on('all', (_event: string, p: string) => {
    if (!isIgnoredEventPath(root, p)) onPaths([p]);
  });
  w.on('error', (err: unknown) => onError(err instanceof Error ? err : new Error(String(err))));
  await new Promise<void>((resolve) => w.once('ready', () => resolve()));
  return {
    mode: 'chokidar',
    stop: () => w.close(),
  };
}
