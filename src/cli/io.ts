import type { RuntimeOptions } from '../core/runtime.js';

export interface CliIO {
  stdout(chunk: string | Buffer): void;
  stderr(chunk: string): void;
  /** Whether stdout is an interactive terminal (colors, confirmations). */
  isTTY: boolean;
  /** Asks a yes/no question; resolves false when no terminal is available. */
  confirm(question: string): Promise<boolean>;
  cwd: string;
  runtime?: RuntimeOptions;
  /** Resolves when the user asks a long-running command (watch) to stop. */
  waitForExit?: () => Promise<void>;
}
