#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main } from './main.js';

const exitCode = await main(process.argv.slice(2), {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
  isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
  cwd: process.cwd(),
  async confirm(question) {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(question);
      return /^(y|yes|c|có|co)$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  },
  waitForExit: () =>
    new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    }),
});
process.exitCode = exitCode;
