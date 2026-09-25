import { describe, expect, it } from 'vitest';
import { detectContentAnomalies, detectHeadAnomaly } from '../../src/core/anomaly.js';
import type { FileChange } from '../../src/core/catalog.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { parseReflog } from '../../src/core/userrepo.js';

const cfg = DEFAULT_CONFIG.anomaly;

function modified(path: string, oldLines: number, newLines: number, added = 0): FileChange {
  const deleted = oldLines - newLines + added;
  return { path, status: 'M', added, deleted, oldLines, newLines };
}

describe('detectContentAnomalies', () => {
  it('rule 1: file shrinking by more than half (original > 20 lines)', () => {
    const f = detectContentAnomalies([modified('src/App.tsx', 340, 12)], cfg);
    expect(f.map((x) => x.rule)).toEqual(['file-shrink']);
    expect(f[0]!.message).toBe('src/App.tsx giảm từ 340 → 12 dòng');
  });

  it('rule 1: ignores small files and moderate shrinking', () => {
    expect(detectContentAnomalies([modified('a.ts', 20, 2)], cfg)).toEqual([]);
    expect(detectContentAnomalies([modified('a.ts', 100, 60)], cfg)).toEqual([]);
  });

  it('rule 1: a deleted file counts as shrinking to 0 lines', () => {
    const f = detectContentAnomalies([{ path: 'big.ts', status: 'D', added: 0, deleted: 40, oldLines: 40, newLines: 0 }], cfg);
    expect(f[0]!.message).toBe('big.ts bị xóa (40 dòng)');
  });

  it('rule 2: net deletion spread over files (> 30% of their lines, >= 50 lines)', () => {
    const changes = [modified('a.ts', 100, 70), modified('b.ts', 100, 70), modified('c.ts', 100, 70)];
    const f = detectContentAnomalies(changes, cfg);
    expect(f.map((x) => x.rule)).toEqual([]); // 90 of 300 = 30%, not above
    const more = [modified('a.ts', 100, 60), modified('b.ts', 100, 60), modified('c.ts', 100, 60)];
    expect(detectContentAnomalies(more, cfg).map((x) => x.rule)).toEqual(['total-delete']);
  });

  it('rule 2: a refactor that moves code between files is not an anomaly', () => {
    const changes: FileChange[] = [
      modified('a.ts', 200, 100),
      { path: 'b.ts', status: 'A', added: 100, deleted: 0, oldLines: 0, newLines: 100 },
    ];
    // a.ts itself shrank by half exactly (not below) → nothing.
    expect(detectContentAnomalies(changes, cfg)).toEqual([]);
  });

  it('rule 2 is not repeated when rule 1 already explains every shrinking file', () => {
    const f = detectContentAnomalies([modified('src/App.tsx', 340, 12)], cfg);
    expect(f.map((x) => x.rule)).toEqual(['file-shrink']);
  });

  it('rule 3: three or more deleted files', () => {
    const del = (p: string): FileChange => ({ path: p, status: 'D', added: 0, deleted: 3, oldLines: 3, newLines: 0 });
    expect(detectContentAnomalies([del('a'), del('b')], cfg)).toEqual([]);
    expect(detectContentAnomalies([del('a'), del('b'), del('c')], cfg).map((x) => x.rule)).toEqual(['files-deleted']);
  });

  it('renames are not deletions', () => {
    const r = (p: string): FileChange => ({ path: `new/${p}`, oldPath: p, status: 'R', added: 0, deleted: 0 });
    expect(detectContentAnomalies([r('a'), r('b'), r('c')], cfg)).toEqual([]);
  });
});

describe('detectHeadAnomaly', () => {
  const oid = 'a'.repeat(40);
  const reflog = (msg: string) => `${oid} ${'b'.repeat(40)} Recode Test <t@t> 1790000000 +0700\t${msg}\n`;

  it('flags reset/checkout while the previous snapshot had uncommitted work', () => {
    const entries = parseReflog(reflog('reset: moving to HEAD'));
    expect(detectHeadAnomaly(entries, true, cfg)?.rule).toBe('head-reset');
    expect(detectHeadAnomaly(parseReflog(reflog('checkout: moving from main to dev')), true, cfg)?.rule).toBe('head-reset');
  });

  it('ignores commits and clean work trees', () => {
    expect(detectHeadAnomaly(parseReflog(reflog('commit: add login')), true, cfg)).toBeUndefined();
    expect(detectHeadAnomaly(parseReflog(reflog('reset: moving to HEAD~1')), false, cfg)).toBeUndefined();
  });
});
