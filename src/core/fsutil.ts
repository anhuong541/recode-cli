import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  if (text.trim() === '') return undefined;
  return JSON.parse(text) as T;
}

/**
 * Write via temp file + rename so a crash never leaves a half-written JSON file.
 * On Windows the rename can fail transiently (antivirus/indexer holding the target), so retry.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 10 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        await sleep(20 * (attempt + 1));
        continue;
      }
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

export function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
