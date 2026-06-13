import { existsSync } from 'node:fs';
import type { WorkerStatus } from '../core/event-log.js';
import { classifyStatus, lastEvent } from '../core/event-log.js';
import { eventsPath } from '../core/paths.js';
import type { WorkerMeta } from '../core/worker-store.js';
import { readMeta, resolveSession } from '../core/worker-store.js';
import type { CommandContext, CommandResult } from './context.js';

/**
 * Compute the current status for a worker given its meta.
 * Reused by the list command.
 */
export async function computeStatus(
  ctx: CommandContext,
  meta: WorkerMeta,
): Promise<WorkerStatus> {
  if (!(await ctx.tmux.hasSession(meta.tmux_name))) {
    return 'gone';
  }
  const ef = eventsPath(ctx.workerDir, meta.session_id);
  if (!existsSync(ef)) {
    return 'unknown';
  }
  const last = lastEvent(ef);
  if (last === null) {
    return 'unknown';
  }
  return classifyStatus(last);
}

export async function cmdStatus(
  ctx: CommandContext,
  worker: string,
): Promise<CommandResult> {
  const sid = resolveSession(ctx.workerDir, worker);
  if (sid === null) {
    return {
      stderr: `Error: no worker known as '${worker}'`,
      code: 1,
    };
  }
  const meta = readMeta(ctx.workerDir, sid);
  if (meta === null) {
    return {
      stderr: `Error: no meta found for worker '${worker}' (sid: ${sid})`,
      code: 1,
    };
  }
  const status = await computeStatus(ctx, meta);
  return { stdout: status, code: 0 };
}
