import { existsSync } from 'node:fs';
import { readRawLines } from '../core/event-log.js';
import { eventsPath } from '../core/paths.js';
import { resolveSession } from '../core/worker-store.js';
import { parseEvent } from '../events.js';
import type { CommandContext, CommandResult } from './context.js';

export interface WaitForTurnOpts {
  /** Timeout in SECONDS (default 60). */
  timeout?: number;
  /**
   * Skip this many leading lines of the events file before scanning for a
   * turn-end. Default: the file's current line count when the call starts — i.e.
   * block until the NEXT turn-end, not one already in the file from a previous
   * turn. (`converse` passes an explicit baseline captured before it sends.)
   */
  afterLine?: number;
  /** Poll interval in ms (default 500). Small values keep tests fast. */
  pollMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const isTurnEnd = (line: string): boolean => {
  const e = parseEvent(line)?.event;
  return e === 'stop' || e === 'session_end';
};

/**
 * Block until the worker finishes a turn: the first `stop` or `session_end`
 * event appended after the baseline. The baseline defaults to the events file's
 * current line count, so a bare `wait-for-turn` waits for the NEXT turn-end
 * rather than returning a stale one from a previous turn. Emits the matching
 * event's RAW JSONL line.
 *
 * A single deadline governs both the wait-for-file-to-exist phase and the
 * poll-for-turn-end phase. On the turn poll, only lines beyond what's already
 * been checked are scanned for the first matching event.
 */
export async function cmdWaitForTurn(
  ctx: CommandContext,
  worker: string,
  opts: WaitForTurnOpts,
): Promise<CommandResult> {
  const timeout = opts.timeout ?? 60;
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

  // Default baseline = current EOF, so a bare call waits for the next turn-end.
  let linesChecked = opts.afterLine ?? readRawLines(eventFile).length;
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
