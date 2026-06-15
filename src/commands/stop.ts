import { readRawLines } from '../core/event-log.js';
import { eventsPath } from '../core/paths.js';
import { removeWorker } from '../core/worker-store.js';
import { parseEvent } from '../events.js';
import type { CommandContext, CommandResult } from './context.js';
import { resolveWorker } from './context.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface StopOpts {
  /** Wait for session_end in SECONDS (default 10). */
  stopTimeout?: number;
  /** Poll interval in ms (default 500). Small values keep tests fast. */
  pollMs?: number;
  /** Settle delay after seeing session_end, ms (default 1000, bash `sleep 1`). */
  settleMs?: number;
}

function sawSessionEnd(eventFile: string): boolean {
  return readRawLines(eventFile).some(
    (line) => parseEvent(line)?.event === 'session_end',
  );
}

/**
 * Stop a worker and remove its shim/meta/events.
 *
 * Parity port of bash `cmd_stop`: if the tmux session is alive, send the
 * harness quit keys (claude: `/exit`) + Enter, wait up to `stopTimeout` for a
 * `session_end` event (settling briefly once seen), then kill the session if it
 * somehow survived. Always remove the worker's files at the end.
 */
export async function cmdStop(
  ctx: CommandContext,
  worker: string,
  opts: StopOpts = {},
): Promise<CommandResult> {
  const resolved = resolveWorker(ctx, worker);
  if ('code' in resolved) return resolved;
  const { sid, meta } = resolved;
  const tmuxName = meta.tmux_name;

  const stopTimeout = opts.stopTimeout ?? ctx.driver.stopGraceSeconds;
  const pollMs = opts.pollMs ?? 500;
  const settleMs = opts.settleMs ?? 1000;
  const eventFile = eventsPath(ctx.workerDir, sid);

  if (await ctx.tmux.hasSession(tmuxName)) {
    await ctx.tmux.sendText(tmuxName, ctx.driver.quitKeys);
    await ctx.tmux.sendEnter(tmuxName);

    const deadline = Date.now() + stopTimeout * 1000;
    while (Date.now() < deadline) {
      if (sawSessionEnd(eventFile)) {
        await sleep(settleMs);
        break;
      }
      // Some harnesses (e.g. codex) exit the pane outright on quit without
      // emitting session_end. Stop waiting the instant the session is gone
      // rather than burning the full grace — harness-agnostic and never less
      // safe (the post-loop check still force-kills a survivor).
      if (!(await ctx.tmux.hasSession(tmuxName))) break;
      await sleep(pollMs);
    }

    if (await ctx.tmux.hasSession(tmuxName)) {
      await ctx.tmux.killSession(tmuxName);
    }
  }

  removeWorker(ctx.workerDir, sid, tmuxName);

  return {
    stdout: `Worker ${tmuxName} (${sid}) stopped. Shim removed.`,
    code: 0,
  };
}
