import type { Tmux } from '../core/tmux.js';
import type { HarnessDriver } from '../harness/driver.js';

export interface CommandContext {
  workerDir: string;
  home: string; // $HOME, used for claude transcript path
  tmux: Tmux;
  driver: HarnessDriver; // the per-worker harness driver (claude for now; resolved by CLI/meta)
}

export interface CommandResult {
  stdout?: string;
  stderr?: string;
  code: number;
}
