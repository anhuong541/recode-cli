import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate every test worker from the developer's own git configuration (autocrlf, hooks,
// signing, excludesFile…) so results are the same on every machine and CI runner.
const dir = mkdtempSync(join(tmpdir(), 'recode-gitcfg-'));
const globalConfig = join(dir, 'gitconfig');
writeFileSync(
  globalConfig,
  ['[user]', '\tname = Recode Test', '\temail = test@recode.local', '[init]', '\tdefaultBranch = main', '[core]', '\tautocrlf = false', ''].join('\n'),
);
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.RECODE_HOME;
