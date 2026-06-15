import { listWorkers, removeWorker } from '../core/worker-store.js';
import type { CommandContext, CommandResult } from './context.js';
import { computeStatus } from './status.js';

/**
 * Remove the runtime state (meta/events/shim/.harness/home) of every worker
 * whose tmux session is `gone`. Only `gone` workers are touched — live workers
 * (idle/working/unknown/terminated-but-present) are left alone. This is the bulk
 * equivalent of the cleanup `stop` does per worker, for fleets where stopped or
 * crashed workers have accumulated in `list --all`.
 */
export async function cmdPrune(ctx: CommandContext): Promise<CommandResult> {
  const metas = listWorkers(ctx.workerDir);
  const pruned: string[] = [];
  for (const meta of metas) {
    if ((await computeStatus(ctx, meta)) !== 'gone') continue;
    removeWorker(ctx.workerDir, meta.session_id, meta.tmux_name);
    pruned.push(meta.tmux_name);
  }

  if (pruned.length === 0) {
    return { stderr: 'No gone workers to prune', code: 0 };
  }
  return {
    stdout: `Pruned ${pruned.length} gone worker(s): ${pruned.join(', ')}`,
    code: 0,
  };
}
