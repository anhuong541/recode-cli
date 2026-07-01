import type { RecodeConfig } from './config.js';

export interface RetentionItem {
  id: string;
  ts: number;
  pinned: boolean;
  pinnedAt?: number;
  coveredAt?: number;
}

export type RetentionReason =
  | 'latest'
  | 'pinned'
  | 'recent'
  | 'bucket'
  | 'covered'
  | 'thinned'
  | 'expired';

export interface RetentionDecision {
  id: string;
  keep: boolean;
  reason: RetentionReason;
}

/**
 * Time-based retention (spec 4D). Pure function so it can be tested with a fake clock.
 * - The newest snapshot is always kept.
 * - Pinned: kept for pinnedKeepMs after pinning.
 * - Covered by a commit: removed once coveredGraceMs has passed since it was marked.
 * - Otherwise: everything younger than keepAllMs, then the newest snapshot per bucket of
 *   each tier, then nothing.
 */
export function planRetention(items: readonly RetentionItem[], now: number, cfg: RecodeConfig['retention']): RetentionDecision[] {
  const sorted = [...items].sort((a, b) => a.ts - b.ts);
  const latestId = sorted.at(-1)?.id;
  const decisions = new Map<string, RetentionDecision>();
  const bucketWinner = new Map<string, RetentionItem>();

  for (const item of sorted) {
    const age = now - item.ts;
    if (item.id === latestId) {
      decisions.set(item.id, { id: item.id, keep: true, reason: 'latest' });
      continue;
    }
    if (item.pinned && now - Math.max(item.ts, item.pinnedAt ?? item.ts) < cfg.pinnedKeepMs) {
      decisions.set(item.id, { id: item.id, keep: true, reason: 'pinned' });
      continue;
    }
    if (item.coveredAt !== undefined && now - item.coveredAt >= cfg.coveredGraceMs) {
      decisions.set(item.id, { id: item.id, keep: false, reason: 'covered' });
      continue;
    }
    if (age < cfg.keepAllMs) {
      decisions.set(item.id, { id: item.id, keep: true, reason: 'recent' });
      continue;
    }
    const tierIndex = cfg.tiers.findIndex((t) => age < t.untilMs);
    if (tierIndex < 0) {
      decisions.set(item.id, { id: item.id, keep: false, reason: 'expired' });
      continue;
    }
    const tier = cfg.tiers[tierIndex]!;
    const key = `${tierIndex}:${Math.floor(item.ts / tier.bucketMs)}`;
    const winner = bucketWinner.get(key);
    // Items are visited oldest first, so a later item in the same bucket replaces the winner.
    if (winner) decisions.set(winner.id, { id: winner.id, keep: false, reason: 'thinned' });
    bucketWinner.set(key, item);
    decisions.set(item.id, { id: item.id, keep: true, reason: 'bucket' });
  }
  return sorted.map((i) => decisions.get(i.id)!);
}
