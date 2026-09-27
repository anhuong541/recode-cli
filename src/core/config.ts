import { join } from 'node:path';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface RecodeConfig {
  schemaVersion: 1;
  snapshot: {
    /** Files bigger than this are skipped (with a warning). */
    maxFileSizeBytes: number;
    /** Extra gitignore-style patterns, on top of the built-in defaults. */
    extraIgnore: string[];
  };
  watch: {
    debounceMs: number;
    maxWaitMs: number;
    pollIntervalMs: number;
    /** Always use polling instead of native file events. */
    forcePoll: boolean;
    headPollMs: number;
    heartbeatMs: number;
    gcIntervalMs: number;
  };
  anomaly: {
    /** A file shrinking below this fraction of its previous line count triggers a pin. */
    fileShrinkRatio: number;
    fileShrinkMinLines: number;
    /** Net deleted lines above this fraction of the changed files' previous lines triggers a pin. */
    totalDeleteRatio: number;
    totalDeleteMinLines: number;
    deletedFilesMin: number;
    headResetPin: boolean;
  };
  retention: {
    keepAllMs: number;
    tiers: { untilMs: number; bucketMs: number }[];
    pinnedKeepMs: number;
    coveredGraceMs: number;
    maxRepoSizeBytes: number;
  };
  alerts: {
    expireMs: number;
  };
  restore: {
    mode: 'ask' | 'self-inflicted-auto';
  };
}

export const DEFAULT_CONFIG: RecodeConfig = {
  schemaVersion: 1,
  snapshot: {
    maxFileSizeBytes: 5 * 1024 * 1024,
    extraIgnore: [],
  },
  watch: {
    debounceMs: 1500,
    maxWaitMs: 10_000,
    pollIntervalMs: 5000,
    forcePoll: false,
    headPollMs: 1000,
    heartbeatMs: 30_000,
    gcIntervalMs: HOUR,
  },
  anomaly: {
    fileShrinkRatio: 0.5,
    fileShrinkMinLines: 20,
    totalDeleteRatio: 0.3,
    totalDeleteMinLines: 50,
    deletedFilesMin: 3,
    headResetPin: true,
  },
  retention: {
    keepAllMs: 2 * HOUR,
    tiers: [
      { untilMs: DAY, bucketMs: 15 * MINUTE },
      { untilMs: 7 * DAY, bucketMs: HOUR },
    ],
    pinnedKeepMs: 14 * DAY,
    coveredGraceMs: DAY,
    maxRepoSizeBytes: 500 * 1024 * 1024,
  },
  alerts: {
    expireMs: DAY,
  },
  restore: {
    mode: 'ask',
  },
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(override) || !isPlainObject(base)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in out)) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = mergeConfig(current, value);
    } else if (value !== undefined && typeof value === typeof current) {
      out[key] = value;
    }
  }
  return out as T;
}

export function configPath(home: string): string {
  return join(home, 'config.json');
}

/** Loads ~/.recode/config.json merged over defaults; writes the defaults on first use. */
export async function loadConfig(home: string): Promise<RecodeConfig> {
  const file = configPath(home);
  const raw = await readJsonFile<unknown>(file);
  if (raw === undefined) {
    await writeJsonAtomic(file, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  return mergeConfig(structuredClone(DEFAULT_CONFIG), raw);
}
