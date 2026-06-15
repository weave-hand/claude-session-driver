import { shimPath } from '../core/paths.js';
import { listWorkers } from '../core/worker-store.js';
import type { CommandContext, CommandResult } from './context.js';
import { computeStatus } from './status.js';

export interface ListOpts {
  /** Include `gone` workers (default false hides them). */
  all?: boolean;
  /** Substring filter on tmux_name. */
  pattern?: string;
}

const HEADER = ['STATUS', 'HARNESS', 'TMUX', 'SESSION_ID', 'SHIM', 'CWD'].join(
  '\t',
);

/**
 * List the known workers as a TAB-separated table.
 *
 * Parity port of bash `cmd_list`: with no metas, emit `No workers found` on
 * stderr and return 0. Otherwise emit a header plus one row per worker, applying
 * the optional substring `pattern` on tmux_name and hiding `gone` workers unless
 * `all` is set. Status comes from the shared `computeStatus`.
 */
export async function cmdList(
  ctx: CommandContext,
  opts: ListOpts,
): Promise<CommandResult> {
  const metas = listWorkers(ctx.workerDir);
  if (metas.length === 0) {
    return { stderr: 'No workers found', code: 0 };
  }

  const rows: string[] = [];
  for (const meta of metas) {
    if (opts.pattern && !meta.tmux_name.includes(opts.pattern)) continue;
    const status = await computeStatus(ctx, meta);
    if (status === 'gone' && !opts.all) continue;
    rows.push(
      [
        status,
        meta.harness,
        meta.tmux_name,
        meta.session_id,
        shimPath(ctx.workerDir, meta.tmux_name),
        meta.cwd,
      ].join('\t'),
    );
  }

  return { stdout: [HEADER, ...rows].join('\n'), code: 0 };
}
