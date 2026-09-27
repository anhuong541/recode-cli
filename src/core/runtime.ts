import { mkdir } from 'node:fs/promises';
import { loadConfig, mergeConfig, type DeepPartial, type RecodeConfig } from './config.js';
import { defaultRecodeHome } from './paths.js';

/** Everything a core operation needs that is not the project itself. Injected for tests. */
export interface Runtime {
  home: string;
  config: RecodeConfig;
  now: () => number;
}

export interface RuntimeOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  config?: DeepPartial<RecodeConfig>;
}

export async function createRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  const home = opts.home ?? defaultRecodeHome(opts.env);
  await mkdir(home, { recursive: true });
  const loaded = await loadConfig(home);
  const config = opts.config ? mergeConfig(loaded, opts.config) : loaded;
  return { home, config, now: opts.now ?? Date.now };
}
