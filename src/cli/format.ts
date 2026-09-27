import { describeStats, type Snapshot } from '../core/catalog.js';
import { SCHEMA_VERSION, summarizeSnapshot } from '../core/context.js';

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function json(data: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...data }, null, 2) + '\n';
}

export function snapshotJson(s: Snapshot) {
  return {
    ...summarizeSnapshot(s, s.files.length),
    ts: s.ts,
    commit: s.commit,
    baseCommit: s.baseCommit,
    previousId: s.previousId,
    pinnedAt: s.pinnedAt ?? null,
    coveredAt: s.coveredAt ?? null,
    changes: s.files,
    filesTruncated: Boolean(s.filesTruncated),
    skipped: s.skipped ?? [],
  };
}

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, [...cell].length)));
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell + ' '.repeat((widths[i] ?? 0) - [...cell].length)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n') + '\n';
}

export function snapshotRow(s: Snapshot): string[] {
  const files = s.baseline ? '(baseline)' : s.files.slice(0, 3).map((f) => f.path).join(', ') + (s.files.length > 3 ? ', …' : '');
  const flags = [s.pinned ? `PINNED${s.pinReason ? `: ${s.pinReason}` : ''}` : '', s.coveredAt ? 'covered' : '']
    .filter(Boolean)
    .join(' | ');
  return [s.id, formatDateTime(s.ts), s.trigger, s.branch ?? '-', describeStats(s.stats), files, flags];
}
