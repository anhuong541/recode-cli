import { RecodeError } from './errors.js';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** rc_MMDD_HHmmss in local time; `_2`, `_3`… are appended on collision. */
export function snapshotIdFor(ts: number, existing: ReadonlySet<string>): string {
  const d = new Date(ts);
  const base = `rc_${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export const SNAPSHOT_ID_RE = /^rc_\d{4}_\d{6}(?:_\d+)?$/;

/**
 * Resolves user input to one snapshot id: exact id, id without the `rc_` prefix,
 * a unique prefix, or `latest`.
 */
export function resolveSnapshotId(input: string, ids: readonly string[], latestId?: string): string {
  const q = input.trim();
  if (q === '') throw new RecodeError('Thiếu snapshot id.', 'SNAPSHOT_ID_MISSING', 2);
  if (q === 'latest' || q === '@') {
    if (!latestId) throw new RecodeError('Chưa có snapshot nào.', 'NO_SNAPSHOTS');
    return latestId;
  }
  const normalized = q.startsWith('rc_') ? q : `rc_${q}`;
  if (ids.includes(normalized)) return normalized;
  const matches = ids.filter((id) => id.startsWith(normalized));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new RecodeError(`Không tìm thấy snapshot "${input}". Xem danh sách bằng: recode list`, 'SNAPSHOT_NOT_FOUND');
  }
  const shown = matches.slice(0, 8).join(', ');
  throw new RecodeError(
    `"${input}" khớp nhiều snapshot (${shown}${matches.length > 8 ? ', …' : ''}). Hãy gõ đầy đủ hơn.`,
    'SNAPSHOT_AMBIGUOUS',
  );
}

/** Parses durations like 90s, 30m, 2h, 1d, 1w. */
export function parseDuration(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(input.trim());
  if (!m) throw new RecodeError(`Không hiểu khoảng thời gian "${input}" (ví dụ: 30m, 2h, 1d).`, 'BAD_DURATION', 2);
  const value = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]!;
  return value * factor;
}
