import { readRawLines } from '../core/event-log.js';
import { eventsPath } from '../core/paths.js';
import { parseEvent } from '../events.js';
import type { CommandContext, CommandResult } from './context.js';
import { resolveWorker } from './context.js';

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Read an env var as a positive number, falling back to `dflt` if unset/invalid. */
function envNumber(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

export interface SendOpts {
  /** Submission-confirm timeout in SECONDS (default 10, honours CSD_SUBMIT_TIMEOUT). */
  submitTimeout?: number;
  /** Seconds between retry-Enter resends (default 2, honours CSD_SUBMIT_RETRY_INTERVAL). */
  retryInterval?: number;
  /** Poll interval in ms (default 250). Small values keep tests fast. */
  pollMs?: number;
}

/**
 * Port of the bash `_prompt_submitted_since`: has a `user_prompt_submit` event
 * appeared after line `beforeLine` of the events file? This is the worker's
 * ground-truth signal that the harness accepted a prompt.
 */
export function promptSubmittedSince(
  eventFile: string,
  beforeLine: number,
): boolean {
  const lines = readRawLines(eventFile);
  if (lines.length <= beforeLine) return false;
  return lines
    .slice(beforeLine)
    .some((line) => parseEvent(line)?.event === 'user_prompt_submit');
}

/**
 * Send a prompt to a worker as a bracketed paste, then confirm submission via
 * the `user_prompt_submit` event (issue #20).
 *
 * Parity port of bash `cmd_send`: the prompt is wrapped in bracketed-paste
 * markers (with any embedded markers stripped so a hostile prompt can't inject
 * its own) and sent as one literal send-keys. Enter is then sent and re-sent
 * every `retryInterval` seconds until the worker emits `user_prompt_submit`
 * (after the events file's pre-send line count) or `submitTimeout` elapses.
 */
export async function cmdSend(
  ctx: CommandContext,
  worker: string,
  prompt: string,
  opts: SendOpts = {},
): Promise<CommandResult> {
  const resolved = resolveWorker(ctx, worker);
  if ('code' in resolved) return resolved;
  const { sid, meta } = resolved;
  const tmuxName = meta.tmux_name;

  if (!(await ctx.tmux.hasSession(tmuxName))) {
    return {
      stderr: `Error: tmux session '${tmuxName}' does not exist`,
      code: 1,
    };
  }

  const submitTimeout =
    opts.submitTimeout ?? envNumber('CSD_SUBMIT_TIMEOUT', 10);
  const retryInterval =
    opts.retryInterval ?? envNumber('CSD_SUBMIT_RETRY_INTERVAL', 2);
  const pollMs = opts.pollMs ?? 250;

  const eventFile = eventsPath(ctx.workerDir, sid);
  const beforeLine = readRawLines(eventFile).length;

  const safe = prompt.split(PASTE_END).join('').split(PASTE_START).join('');
  await ctx.tmux.sendText(tmuxName, PASTE_START + safe + PASTE_END);

  // The harness converts the bracketed paste into a pending-input widget
  // asynchronously; an Enter sent too early can be swallowed (issue #20).
  // Re-send Enter until the worker confirms via user_prompt_submit or we time out.
  await ctx.tmux.sendEnter(tmuxName);
  const deadline = Date.now() + submitTimeout * 1000;
  let sinceEnter = Date.now();
  while (!promptSubmittedSince(eventFile, beforeLine)) {
    if (Date.now() >= deadline) {
      return {
        stderr: `Error: prompt pasted but worker did not confirm submission within ${submitTimeout}s (issue #20). The tmux session may be slow to accept the paste; raise CSD_SUBMIT_TIMEOUT to allow more time.`,
        code: 1,
      };
    }
    await sleep(pollMs);
    if (Date.now() - sinceEnter >= retryInterval * 1000) {
      await ctx.tmux.sendEnter(tmuxName);
      sinceEnter = Date.now();
    }
  }

  return { code: 0 };
}
