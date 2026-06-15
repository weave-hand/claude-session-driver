import {
  listOrphanNames,
  listWorkers,
  removeOrphan,
  removeWorker,
} from '../core/worker-store.js';
import type { CommandContext, CommandResult } from './context.js';
import { computeStatus } from './status.js';

/**
 * Remove dead worker state. Two passes: (1) every registered worker whose tmux
 * session is `gone` (meta/events/shim/.harness/home — the bulk equivalent of
 * `stop`); (2) meta-less leftover sidecars/shims whose tmux session is also gone
 * (orphans from workers that bypassed `stop` — invisible to `list`). Live workers
 * — including derive workers in their pre-registration window — are left alone.
 */
export async function cmdPrune(ctx: CommandContext): Promise<CommandResult> {
  const removed: string[] = [];

  for (const meta of listWorkers(ctx.workerDir)) {
    if ((await computeStatus(ctx, meta)) !== 'gone') continue;
    removeWorker(ctx.workerDir, meta.session_id, meta.tmux_name);
    removed.push(meta.tmux_name);
  }

  for (const name of listOrphanNames(ctx.workerDir)) {
    // A live worker without a meta is a derive worker mid-registration — keep it.
    if (await ctx.tmux.hasSession(name)) continue;
    removeOrphan(ctx.workerDir, name);
    removed.push(name);
  }

  if (removed.length === 0) {
    return { stderr: 'Nothing to prune', code: 0 };
  }
  return {
    stdout: `Pruned ${removed.length} dead worker(s)/orphan(s): ${removed.join(', ')}`,
    code: 0,
  };
}
