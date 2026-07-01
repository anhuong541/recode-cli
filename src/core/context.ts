import { basename } from 'node:path';
import { activeAlerts, type Alert } from './alerts.js';
import { listSnapshots, type Snapshot, type SnapshotStats, describeStats } from './catalog.js';
import { readMeta, type RepoWarning } from './meta.js';
import type { Project } from './project.js';
import type { Runtime } from './runtime.js';
import { headInfo, readUserRepo, type HeadInfo } from './userrepo.js';
import { protectionOf, type Protection } from './watchstate.js';

export const SCHEMA_VERSION = 1;

export interface SnapshotSummary {
  id: string;
  timestamp: string;
  trigger: string;
  branch: string | null;
  message?: string;
  pinned: boolean;
  pinReason: string | null;
  covered: boolean;
  stats: SnapshotStats;
  files: string[];
}

export interface ContextData {
  schemaVersion: number;
  project: { name: string; root: string; repoId: string; branch: string | null; head: HeadInfo | null };
  protection: Protection;
  snapshotCount: number;
  alerts: Alert[];
  pinned: SnapshotSummary[];
  recent: SnapshotSummary[];
  warnings: RepoWarning[];
  commands: { diff: string; restoreFiles: string };
}

export function summarizeSnapshot(s: Snapshot, maxFiles = 5): SnapshotSummary {
  return {
    id: s.id,
    timestamp: s.timestamp,
    trigger: s.trigger,
    branch: s.branch,
    ...(s.message ? { message: s.message } : {}),
    pinned: s.pinned,
    pinReason: s.pinReason,
    covered: Boolean(s.coveredAt),
    stats: s.stats,
    files: s.files.slice(0, maxFiles).map((f) => f.path),
  };
}

export async function buildContext(rt: Runtime, project: Project, opts: { recent?: number } = {}): Promise<ContextData> {
  const meta = await readMeta(project);
  const [snapshots, alerts, protection, user, head] = await Promise.all([
    listSnapshots(project, meta),
    activeAlerts(rt, project),
    protectionOf(rt, project),
    readUserRepo(project.root),
    headInfo(project.root),
  ]);
  const newestFirst = [...snapshots].reverse();
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      name: basename(project.root),
      root: project.root,
      repoId: project.repoId,
      branch: user.branch ?? null,
      head: head ?? null,
    },
    protection,
    snapshotCount: snapshots.length,
    alerts,
    pinned: newestFirst.filter((s) => s.pinned).map((s) => summarizeSnapshot(s)),
    recent: newestFirst.slice(0, opts.recent ?? 10).map((s) => summarizeSnapshot(s)),
    warnings: meta.warnings,
    commands: {
      diff: 'recode diff <id> --against current -- <path>',
      restoreFiles: 'recode restore <id> -- <path>',
    },
  };
}

export function formatClock(iso: string | number): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(fromMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - fromMs);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'vừa xong';
  if (min < 60) return `${min} phút trước`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

function snapshotLine(s: SnapshotSummary): string {
  const files = s.files.length > 0 ? ` — ${s.files.join(', ')}` : '';
  const pin = s.pinned ? ' (PINNED)' : '';
  return `- ${s.id} — ${describeStats(s.stats)}${files}${pin}`;
}

export function renderContextMarkdown(ctx: ContextData, now: number): string {
  const lines: string[] = [];
  lines.push(`# RECODE CONTEXT — ${ctx.project.name} (branch: ${ctx.project.branch ?? 'detached/không có'})`);
  if (ctx.project.head) {
    const h = ctx.project.head;
    lines.push(`HEAD: ${h.short} "${h.subject}" (${relativeTime(h.time, now)})`);
  } else {
    lines.push('HEAD: (chưa có commit hoặc không đọc được .git)');
  }
  lines.push(`Trạng thái bảo vệ: ${ctx.protection.message}`);
  lines.push(`Số snapshot: ${ctx.snapshotCount}`);
  for (const w of ctx.warnings) lines.push(`Cảnh báo: ${w.message}`);

  lines.push('', '## Alert chưa xử lý');
  if (ctx.alerts.length === 0) lines.push('- (không có)');
  for (const a of ctx.alerts) {
    lines.push(
      `- ${formatClock(a.createdAt)} — ${a.reasons.join('; ')} (do ${a.trigger}). Bản tốt: ${a.goodSnapshotId} (PINNED)${a.status === 'acknowledged' ? ' [đã xem]' : ''}`,
    );
  }

  lines.push('', '## Snapshot đã pin');
  if (ctx.pinned.length === 0) lines.push('- (không có)');
  for (const s of ctx.pinned) {
    lines.push(`- ${s.id} — PINNED — ${describeStats(s.stats)}${s.pinReason ? ` — ${s.pinReason}` : ''}`);
  }

  lines.push('', '## Snapshot gần đây (mới nhất trước)');
  if (ctx.recent.length === 0) lines.push('- (chưa có snapshot)');
  for (const s of ctx.recent) lines.push(snapshotLine(s));

  lines.push('', '## Lệnh');
  lines.push(`- Xem khác biệt: ${ctx.commands.diff}`);
  lines.push(`- Khôi phục từng file: ${ctx.commands.restoreFiles}`);
  return lines.join('\n') + '\n';
}
