import { existsSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { relative, sep } from 'node:path';
import { describeStats } from '../core/catalog.js';
import { RecodeError } from '../core/errors.js';
import { isProcessAlive } from '../core/fsutil.js';
import { runGc } from '../core/gc.js';
import { splitNul } from '../core/git.js';
import { unreliableEventsReason } from '../core/paths.js';
import type { Project } from '../core/project.js';
import type { Runtime } from '../core/runtime.js';
import { createSnapshot, type CreateSnapshotResult } from '../core/snapshot.js';
import { ensureStore, storeGit } from '../core/store.js';
import { readUserRepo, reflogFile } from '../core/userrepo.js';
import { clearWatchState, readWatchState, writeWatchState, type WatchMode, type WatchState } from '../core/watchstate.js';
import { SnapshotScheduler } from './scheduler.js';
import { startChokidarSource, startNativeSource, type FileEventSource, type OnError, type OnPaths } from './sources.js';

export interface WatchSessionOptions {
  forcePoll?: boolean;
  log?: (line: string) => void;
  onSnapshot?: (res: CreateSnapshotResult) => void;
  /** Replaces the native file-event source (tests). */
  startSource?: (root: string, onPaths: OnPaths, onError: OnError) => Promise<FileEventSource>;
}

const WATCHER_ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Foreground watcher for one project (Phase 1, no daemon): baseline snapshot, then
 * debounced snapshots on file events, HEAD/reflog monitoring, heartbeat and hourly GC.
 */
export class WatchSession {
  private scheduler: SnapshotScheduler;
  private source: FileEventSource | undefined;
  private intervals: NodeJS.Timeout[] = [];
  private watchedFiles: string[] = [];
  private pendingPaths = new Set<string>();
  private forceNext = false;
  private state: WatchState | undefined;
  private stopped = false;
  private rootMissing = false;
  private lastWatcherErrorLogAt = 0;
  mode: WatchMode = 'native';
  modeReason: string | undefined;

  constructor(
    private readonly rt: Runtime,
    private readonly project: Project,
    private readonly opts: WatchSessionOptions = {},
  ) {
    this.scheduler = new SnapshotScheduler(() => this.snapshotJob(), {
      debounceMs: rt.config.watch.debounceMs,
      maxWaitMs: rt.config.watch.maxWaitMs,
    });
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  async start(): Promise<void> {
    const existing = await readWatchState(this.project);
    if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
      const age = this.rt.now() - Date.parse(existing.heartbeatAt);
      if (age < this.rt.config.watch.heartbeatMs * 3) {
        throw new RecodeError(`Đã có "recode watch" khác đang chạy cho project này (PID ${existing.pid}).`, 'WATCH_RUNNING');
      }
    }
    await ensureStore(this.rt, this.project);

    const baseline = await createSnapshot(this.rt, this.project, { trigger: 'watch', message: 'baseline khi bắt đầu watch' });
    this.report(baseline, true);

    const reason = this.opts.forcePoll || this.rt.config.watch.forcePoll ? 'bật thủ công (--poll)' : unreliableEventsReason(this.project.root);
    if (reason) {
      this.startPolling(reason);
    } else {
      await this.startEvents();
    }
    await this.startHeadMonitor();

    const now = new Date(this.rt.now()).toISOString();
    this.state = { pid: process.pid, startedAt: now, heartbeatAt: now, mode: this.mode, modeReason: this.modeReason };
    await writeWatchState(this.project, this.state);
    this.intervals.push(setInterval(() => void this.heartbeat(), this.rt.config.watch.heartbeatMs));
    this.intervals.push(setInterval(() => void this.gc(), this.rt.config.watch.gcIntervalMs));
    // Native watchers die with their directory, so existence is checked on a timer.
    this.intervals.push(setInterval(() => void this.checkRoot(), this.rt.config.watch.pollIntervalMs));
    this.log(`Đang theo dõi ${this.project.root} (${this.mode}${this.modeReason ? `: ${this.modeReason}` : ''}). Ctrl+C để dừng.`);
  }

  private startPolling(reason: string): void {
    this.mode = 'poll';
    this.modeReason = reason;
    this.log(`Cảnh báo: file event không đáng tin cậy (${reason}) → chuyển sang polling ${this.rt.config.watch.pollIntervalMs / 1000}s.`);
    this.intervals.push(
      setInterval(() => {
        this.forceNext = true;
        this.scheduler.touch();
      }, this.rt.config.watch.pollIntervalMs),
    );
  }

  private async startEvents(): Promise<void> {
    const onPaths = (paths: string[]) => {
      for (const p of paths) this.pendingPaths.add(p);
      this.scheduler.touch();
    };
    const onError = (err: Error) => this.handleWatcherError(err);
    try {
      this.source = await (this.opts.startSource ?? startNativeSource)(this.project.root, onPaths, onError);
    } catch (err) {
      this.log(`Không khởi động được @parcel/watcher (${(err as Error).message}); dùng chokidar.`);
      try {
        this.source = await startChokidarSource(this.project.root, onPaths, onError);
      } catch (err2) {
        this.startPolling(`không khởi động được watcher: ${(err2 as Error).message}`);
        return;
      }
    }
    this.mode = this.source.mode;
  }

  /** .git/HEAD and .git/logs/HEAD: detects commit / checkout / reset (spec 4B exception). */
  private async startHeadMonitor(): Promise<void> {
    this.stopHeadMonitor();
    const user = await readUserRepo(this.project.root);
    if (!user.gitDir) return;
    const files = [`${user.gitDir}${sep}HEAD`, reflogFile(user.gitDir)];
    for (const file of files) {
      watchFile(file, { interval: this.rt.config.watch.headPollMs }, (cur: Stats, prev: Stats) => {
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) {
          this.forceNext = true;
          this.scheduler.touch();
        }
      });
      this.watchedFiles.push(file);
    }
  }

  private stopHeadMonitor(): void {
    for (const f of this.watchedFiles) unwatchFile(f);
    this.watchedFiles = [];
  }

  /**
   * Any watcher error can mean missed events (FSEvents "events were dropped" when many
   * files change at once, inotify queue overflow). A snapshot rescans the whole work tree
   * anyway, so force one instead of trusting the event stream.
   */
  private handleWatcherError(err: Error): void {
    this.forceNext = true;
    this.scheduler.touch();
    const now = Date.now();
    if (now - this.lastWatcherErrorLogAt < WATCHER_ERROR_LOG_INTERVAL_MS) return;
    this.lastWatcherErrorLogAt = now;
    const dropped = /dropped|re-?scan|overflow/i.test(err.message);
    this.log(
      dropped
        ? 'Watcher báo đã bỏ lỡ sự kiện (nhiều file thay đổi cùng lúc) → quét lại toàn bộ project.'
        : `Lỗi watcher: ${err.message} → quét lại toàn bộ project.`,
    );
  }

  private async checkRoot(): Promise<void> {
    if (this.stopped) return;
    const exists = existsSync(this.project.root);
    if (!exists && !this.rootMissing) await this.markRootMissing();
    else if (exists && this.rootMissing) await this.resume();
  }

  /** Principle 7: say it once, loudly, then stay quiet until the folder is back. */
  private async markRootMissing(): Promise<void> {
    if (this.rootMissing) return;
    this.rootMissing = true;
    this.log(
      `CẢNH BÁO: thư mục project đã bị xóa (${this.project.root}). Tạm dừng snapshot; snapshot cũ vẫn còn.\n` +
        `  Khôi phục: recode restore latest --project "${this.project.root}" --to <thư mục mới>`,
    );
    this.stopHeadMonitor();
    const source = this.source;
    this.source = undefined;
    await source?.stop().catch(() => undefined);
  }

  private async resume(): Promise<void> {
    if (this.stopped || !this.rootMissing) return;
    this.rootMissing = false;
    this.log('Thư mục project đã xuất hiện lại → tiếp tục theo dõi.');
    if (this.mode !== 'poll') await this.startEvents();
    await this.startHeadMonitor();
    this.forceNext = true;
    this.scheduler.touch();
  }

  /** True when every changed path is gitignored, so a snapshot cannot change anything. */
  private async allIgnored(paths: string[]): Promise<boolean> {
    const rels = paths.map((p) => relative(this.project.root, p).split(sep).join('/')).filter((p) => p && !p.includes('\n'));
    if (rels.length === 0) return false;
    const res = await storeGit(this.project, ['check-ignore', '-z', '--stdin'], {
      input: rels.join('\0') + '\0',
      allowFailure: true,
    });
    if (res.code > 1) return false;
    return splitNul(res.stdout).length === rels.length;
  }

  private async snapshotJob(): Promise<void> {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    const force = this.forceNext;
    this.forceNext = false;
    if (!existsSync(this.project.root)) {
      await this.markRootMissing();
      return;
    }
    try {
      if (!force && paths.length > 0 && (await this.allIgnored(paths))) return;
      const res = await createSnapshot(this.rt, this.project, { trigger: 'watch' });
      this.report(res, false);
    } catch (err) {
      this.log(`Lỗi khi snapshot: ${(err as Error).message}`);
    }
  }

  private report(res: CreateSnapshotResult, baseline: boolean): void {
    this.opts.onSnapshot?.(res);
    if (!res.created) {
      if (baseline) this.log(`Không có thay đổi so với snapshot mới nhất ${res.snapshot.id}.`);
      return;
    }
    const files = res.snapshot.files.slice(0, 3).map((f) => f.path).join(', ');
    this.log(`snapshot ${res.snapshot.id} — ${baseline ? 'baseline' : describeStats(res.snapshot.stats)}${files ? ` — ${files}` : ''}`);
    for (const s of res.skipped) this.log(`  bỏ qua ${s.path}: ${s.reason}`);
    if (res.alert) {
      this.log(`AUTO-PIN ${res.alert.goodSnapshotId}: ${res.alert.reasons.join('; ')}`);
      this.log(`  Khôi phục: recode restore ${res.alert.goodSnapshotId} -- <path>`);
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.state || this.stopped) return;
    this.state.heartbeatAt = new Date(this.rt.now()).toISOString();
    try {
      await writeWatchState(this.project, this.state);
    } catch (err) {
      this.log(`Không ghi được heartbeat: ${(err as Error).message}`);
    }
  }

  private async gc(): Promise<void> {
    try {
      const res = await runGc(this.rt, this.project);
      if (res.deleted.length > 0) this.log(`GC: xóa ${res.deleted.length} snapshot cũ.`);
      if (res.sizeWarning) this.log(`Cảnh báo: ${res.sizeWarning}`);
    } catch (err) {
      this.log(`Lỗi GC: ${(err as Error).message}`);
    }
  }

  /** Waits for pending snapshots (tests use this to make timing deterministic). */
  async flush(): Promise<void> {
    await this.scheduler.flush();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const i of this.intervals) clearInterval(i);
    this.stopHeadMonitor();
    await this.source?.stop().catch(() => undefined);
    await this.scheduler.stop({ flush: true });
    await clearWatchState(this.project, process.pid);
  }
}
