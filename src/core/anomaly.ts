import type { FileChange } from './catalog.js';
import type { RecodeConfig } from './config.js';
import { isDestructiveHeadMove, type ReflogEntry } from './userrepo.js';

export interface AnomalyFinding {
  rule: 'file-shrink' | 'total-delete' | 'files-deleted' | 'head-reset';
  path?: string;
  /** Human readable, e.g. "src/App.tsx giảm từ 340 → 12 dòng". */
  message: string;
}

/**
 * Rules of spec 4C, evaluated on the changes from the previous snapshot to a new one.
 * When anything is found, the PREVIOUS snapshot (the last good state) gets pinned.
 */
export function detectContentAnomalies(changes: readonly FileChange[], cfg: RecodeConfig['anomaly']): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];

  // Rule 1: a file with more than N lines shrank below ratio (a deleted file shrinks to 0).
  for (const c of changes) {
    if (c.oldLines === undefined || c.newLines === undefined) continue;
    if (c.oldLines <= cfg.fileShrinkMinLines) continue;
    if (c.newLines >= c.oldLines * cfg.fileShrinkRatio) continue;
    const label = c.oldPath && c.oldPath !== c.path ? `${c.oldPath} → ${c.path}` : c.path;
    findings.push({
      rule: 'file-shrink',
      path: c.path,
      message:
        c.status === 'D'
          ? `${label} bị xóa (${c.oldLines} dòng)`
          : `${label} giảm từ ${c.oldLines} → ${c.newLines} dòng`,
    });
  }

  // Rule 2: net deleted lines exceed ratio of the changed files' previous size.
  let netDeleted = 0;
  let previousLines = 0;
  let counted = 0;
  for (const c of changes) {
    if (c.binary || c.added === undefined || c.deleted === undefined) continue;
    netDeleted += c.deleted - c.added;
    if (c.oldLines !== undefined) {
      previousLines += c.oldLines;
      counted++;
    }
  }
  // Skip when every file that lost lines is already reported by rule 1 (same news twice).
  const shrunk = new Set(findings.map((f) => f.path));
  const losers = changes.filter((c) => !c.binary && (c.deleted ?? 0) > (c.added ?? 0));
  const alreadyExplained = losers.length > 0 && losers.every((c) => shrunk.has(c.path));
  if (
    !alreadyExplained &&
    netDeleted >= cfg.totalDeleteMinLines &&
    previousLines > 0 &&
    netDeleted > previousLines * cfg.totalDeleteRatio
  ) {
    const pct = Math.round((netDeleted / previousLines) * 100);
    findings.push({
      rule: 'total-delete',
      message: `Xóa ròng ${netDeleted} dòng trên ${counted} file (${pct}% của ${previousLines} dòng trước đó)`,
    });
  }

  // Rule 3: many files deleted at once (renames are not deletions).
  const deleted = changes.filter((c) => c.status === 'D');
  if (deleted.length >= cfg.deletedFilesMin) {
    const names = deleted.slice(0, 5).map((c) => c.path).join(', ');
    findings.push({
      rule: 'files-deleted',
      message: `${deleted.length} file bị xóa: ${names}${deleted.length > 5 ? ', …' : ''}`,
    });
  }

  return findings;
}

/** Rule 4: HEAD was reset / switched while the previous snapshot had uncommitted work. */
export function detectHeadAnomaly(
  entries: readonly ReflogEntry[],
  previousWasDirty: boolean,
  cfg: RecodeConfig['anomaly'],
): AnomalyFinding | undefined {
  if (!cfg.headResetPin || !previousWasDirty) return undefined;
  const move = entries.filter(isDestructiveHeadMove).at(-1);
  if (!move) return undefined;
  return {
    rule: 'head-reset',
    message: `HEAD thay đổi ("${move.message}") trong khi còn thay đổi chưa commit`,
  };
}
