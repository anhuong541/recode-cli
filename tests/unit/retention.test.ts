import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { planRetention, type RetentionItem } from '../../src/core/retention.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const cfg = DEFAULT_CONFIG.retention;
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

function item(id: string, ageMs: number, extra: Partial<RetentionItem> = {}): RetentionItem {
  return { id, ts: NOW - ageMs, pinned: false, ...extra };
}

function kept(items: RetentionItem[], now = NOW) {
  return planRetention(items, now, cfg)
    .filter((d) => d.keep)
    .map((d) => d.id);
}

describe('planRetention', () => {
  it('keeps everything younger than 2 hours', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`s${i}`, (i + 1) * MIN));
    expect(kept(items)).toHaveLength(50);
  });

  it('keeps one snapshot per 15 minutes between 2 and 24 hours', () => {
    // 12 snapshots, one every 5 minutes, all between 3h and 4h old → 4 buckets of 15 minutes.
    const items = Array.from({ length: 12 }, (_, i) => item(`s${i}`, 3 * HOUR + i * 5 * MIN));
    items.push(item('latest', 0));
    const decisions = planRetention(items, NOW, cfg);
    const keptOld = decisions.filter((d) => d.keep && d.id !== 'latest');
    expect(keptOld.length).toBeGreaterThanOrEqual(4);
    expect(keptOld.length).toBeLessThanOrEqual(5);
    expect(decisions.filter((d) => d.reason === 'thinned').length).toBe(12 - keptOld.length);
  });

  it('keeps the newest snapshot of each bucket', () => {
    const bucketStart = Math.floor((NOW - 5 * HOUR) / (15 * MIN)) * 15 * MIN;
    const items = [
      { id: 'old', ts: bucketStart + 1 * MIN, pinned: false },
      { id: 'newer', ts: bucketStart + 10 * MIN, pinned: false },
      item('latest', 0),
    ];
    expect(kept(items)).toEqual(['newer', 'latest']);
  });

  it('keeps one per hour between 1 and 7 days, deletes older than 7 days', () => {
    const items = [
      item('d2a', 2 * DAY + 10 * MIN),
      item('d2b', 2 * DAY + 20 * MIN),
      item('d8', 8 * DAY),
      item('latest', 0),
    ];
    const decisions = Object.fromEntries(planRetention(items, NOW, cfg).map((d) => [d.id, d]));
    expect(decisions.d8!.reason).toBe('expired');
    expect([decisions.d2a!.keep, decisions.d2b!.keep].filter(Boolean)).toHaveLength(1);
  });

  it('never deletes the latest snapshot, even when very old or covered', () => {
    const items = [item('only', 30 * DAY, { coveredAt: NOW - 10 * DAY })];
    expect(kept(items)).toEqual(['only']);
  });

  it('keeps pinned snapshots for 14 days after pinning, then applies normal rules', () => {
    const items = [
      item('pinned-10d', 10 * DAY, { pinned: true, pinnedAt: NOW - 10 * DAY }),
      item('pinned-15d', 15 * DAY, { pinned: true, pinnedAt: NOW - 15 * DAY }),
      item('latest', 0),
    ];
    expect(kept(items)).toEqual(['pinned-10d', 'latest']);
  });

  it('removes covered snapshots only after the 24h grace period', () => {
    const items = [
      item('covered-fresh', 30 * MIN, { coveredAt: NOW - 20 * MIN }),
      item('covered-old', 26 * HOUR, { coveredAt: NOW - 25 * HOUR }),
      item('latest', 0),
    ];
    const d = Object.fromEntries(planRetention(items, NOW, cfg).map((x) => [x.id, x]));
    expect(d['covered-fresh']!.keep).toBe(true);
    expect(d['covered-old']!.keep).toBe(false);
    expect(d['covered-old']!.reason).toBe('covered');
  });

  it('does not remove covered snapshots that are pinned', () => {
    const items = [item('p', 3 * DAY, { pinned: true, pinnedAt: NOW - 3 * DAY, coveredAt: NOW - 2 * DAY }), item('latest', 0)];
    expect(kept(items)).toEqual(['p', 'latest']);
  });
});
