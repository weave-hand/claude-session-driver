import { shimPath } from '../core/paths.js';
import {
  listOrphanNames,
  listWorkers,
  readHarnessMarker,
} from '../core/worker-store.js';
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
 * One row per registered worker (status from the shared `computeStatus`, `gone`
 * hidden unless `all`), plus an `unregistered` row for each derive worker that
 * has launched but not yet minted its id — a live tmux session + `.harness`
 * sidecar with no meta (RE-2; invisible otherwise). The optional substring
 * `pattern` filters on tmux_name. When nothing matches, emit `No workers found`
 * on stderr rather than a bare header (RE-6).
 */
export async function cmdList(
  ctx: CommandContext,
  opts: ListOpts,
): Promise<CommandResult> {
  const rows: string[] = [];

  for (const meta of listWorkers(ctx.workerDir)) {
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

  // Launched-but-unregistered derive workers: sidecar + live tmux, no meta yet.
  for (const name of listOrphanNames(ctx.workerDir)) {
    if (opts.pattern && !name.includes(opts.pattern)) continue;
    if (!(await ctx.tmux.hasSession(name))) continue; // dead leftover -> prune territory
    rows.push(
      [
        'unregistered',
        readHarnessMarker(ctx.workerDir, name) ?? '?',
        name,
        '-',
        shimPath(ctx.workerDir, name),
        '-',
      ].join('\t'),
    );
  }

  if (rows.length === 0) {
    return { stderr: 'No workers found', code: 0 };
  }
  return { stdout: [HEADER, ...rows].join('\n'), code: 0 };
}
