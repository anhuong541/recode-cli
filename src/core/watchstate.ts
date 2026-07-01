import { rm } from 'node:fs/promises';
import { isProcessAlive, readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { Project } from './project.js';
import type { Runtime } from './runtime.js';

export type WatchMode = 'native' | 'chokidar' | 'poll';

export interface WatchState {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  mode: WatchMode;
  modeReason?: string;
}

export type ProtectionStatus = 'watching' | 'not-watching' | 'stale';

export interface Protection {
  status: ProtectionStatus;
  message: string;
  watch?: WatchState;
}

export async function writeWatchState(project: Project, state: WatchState): Promise<void> {
  await writeJsonAtomic(project.watchFile, state);
}

export async function clearWatchState(project: Project, pid: number): Promise<void> {
  const current = await readJsonFile<WatchState>(project.watchFile);
  if (current?.pid === pid) await rm(project.watchFile, { force: true });
}

export async function readWatchState(project: Project): Promise<WatchState | undefined> {
  return readJsonFile<WatchState>(project.watchFile);
}

/** Principle 7: an unprotected project must be reported loudly, never silently. */
export async function protectionOf(rt: Runtime, project: Project): Promise<Protection> {
  const state = await readWatchState(project);
  if (!state) {
    return {
      status: 'not-watching',
      message: 'KHÔNG được bảo vệ liên tục: "recode watch" không chạy cho project này. Chỉ có snapshot thủ công.',
    };
  }
  const age = rt.now() - Date.parse(state.heartbeatAt);
  const alive = isProcessAlive(state.pid) && age < rt.config.watch.heartbeatMs * 3;
  if (!alive) {
    return {
      status: 'stale',
      message: `KHÔNG được bảo vệ: tiến trình "recode watch" (PID ${state.pid}) đã dừng, heartbeat cuối ${Math.round(age / 1000)}s trước.`,
      watch: state,
    };
  }
  const mode =
    state.mode === 'poll' ? `polling ${Math.round(rt.config.watch.pollIntervalMs / 1000)}s${state.modeReason ? ` — ${state.modeReason}` : ''}` : state.mode;
  return { status: 'watching', message: `OK ("recode watch" đang chạy, PID ${state.pid}, ${mode})`, watch: state };
}
