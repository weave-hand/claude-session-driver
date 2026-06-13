import { existsSync, readFileSync } from 'node:fs';
import { eventsPath } from '../core/paths.js';
import { resolveSession } from '../core/worker-store.js';
import { parseEvent } from '../events.js';
import type { CommandContext, CommandResult } from './context.js';

export interface WaitForTurnOpts {
  /** Timeout in SECONDS (default 60). */
  timeout?: number;
  /** Only consider event lines AFTER this 1-based line number (default 0). */
  afterLine?: number;
  /** Poll interval in ms (default 500). Small values keep tests fast. */
  pollMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Read the raw, non-empty JSONL lines of an events file. */
function readRawLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

const isTurnEnd = (line: string): boolean => {
  const e = parseEvent(line)?.event;
  return e === 'stop' || e === 'session_end';
};

/**
 * Block until the worker finishes a turn: the first `stop` or `session_end`
 * event appended after line `afterLine`. Emits that event's RAW JSONL line.
 *
 * Mirrors the bash `cmd_wait_for_turn`: a single deadline governs both the
 * wait-for-file-to-exist phase and the poll-for-turn-end phase. On the turn
 * poll, only lines beyond what's already been checked are scanned for the
 * first matching event.
 */
export async function cmdWaitForTurn(
  ctx: CommandContext,
  worker: string,
  opts: WaitForTurnOpts,
): Promise<CommandResult> {
  const timeout = opts.timeout ?? 60;
  const afterLine = opts.afterLine ?? 0;
  const pollMs = opts.pollMs ?? 500;

  const sid = resolveSession(ctx.workerDir, worker);
  if (sid === null) {
    return { stderr: `Error: no worker known as '${worker}'`, code: 1 };
  }

  const eventFile = eventsPath(ctx.workerDir, sid);
  const deadline = Date.now() + timeout * 1000;

  while (!existsSync(eventFile)) {
    if (Date.now() >= deadline) {
      return {
        stderr: `Timeout waiting for event file: ${eventFile}`,
        code: 1,
      };
    }
    await sleep(pollMs);
  }

  let linesChecked = afterLine;
  while (Date.now() < deadline) {
    const lines = readRawLines(eventFile);
    if (lines.length > linesChecked) {
      const match = lines.slice(linesChecked).find(isTurnEnd);
      if (match !== undefined) {
        return { stdout: match, code: 0 };
      }
      linesChecked = lines.length;
    }
    await sleep(pollMs);
  }

  return {
    stderr: `Timeout waiting for turn (stop or session_end) after ${timeout}s`,
    code: 1,
  };
}
