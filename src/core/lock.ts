import { open, readFile, rm, stat } from 'node:fs/promises';
import { RecodeError } from './errors.js';
import { isNotFound, isProcessAlive, sleep } from './fsutil.js';

const inProcess = new Map<string, Promise<unknown>>();

export interface LockOptions {
  timeoutMs?: number;
  /** A lock older than this whose owner is dead is considered stale. */
  staleMs?: number;
}

async function tryRemoveStale(file: string, staleMs: number): Promise<boolean> {
  try {
    const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const pid = Number(text.split('\n')[0]);
    const known = Number.isInteger(pid) && pid > 0;
    // A lock whose owner died is stale right away; an empty/garbled one (crash between
    // open() and write()) only after staleMs, since its owner may still be writing it.
    if ((known && !isProcessAlive(pid)) || (!known && Date.now() - st.mtimeMs > staleMs)) {
      await rm(file, { force: true });
      return true;
    }
  } catch (err) {
    if (isNotFound(err)) return true;
  }
  return false;
}

async function acquireFileLock(file: string, opts: Required<LockOptions>): Promise<() => Promise<void>> {
  const deadline = Date.now() + opts.timeoutMs;
  let delay = 25;
  for (;;) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      return async () => {
        await rm(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await tryRemoveStale(file, opts.staleMs);
    if (Date.now() > deadline) {
      throw new RecodeError(
        `Không lấy được khóa ${file} (một tiến trình recode khác đang chạy?). Thử lại sau.`,
        'LOCK_TIMEOUT',
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 250);
  }
}

/**
 * Serialises work on one shadow repo, both inside this process (watch timers) and across
 * processes (`recode watch` + a manual `recode save`).
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const opts: Required<LockOptions> = { timeoutMs: 60_000, staleMs: 30_000, ...options };
  const previous = inProcess.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const chained = previous.then(() => current);
  inProcess.set(file, chained);
  await previous.catch(() => undefined);
  try {
    const unlock = await acquireFileLock(file, opts);
    try {
      return await fn();
    } finally {
      await unlock();
    }
  } finally {
    release();
    if (inProcess.get(file) === chained) inProcess.delete(file);
  }
}
