import type { CommandContext, CommandResult } from './context.js';
import { resolveWorker } from './context.js';

/**
 * Print instructions for a human to take over the worker's tmux session. The
 * `$WORKER` token in the resume note is intentionally literal (matching the
 * bash heredoc's `\$WORKER`): it shows the user the shim invocation to avoid.
 */
export async function cmdHandoff(
  ctx: CommandContext,
  worker: string,
): Promise<CommandResult> {
  const resolved = resolveWorker(ctx, worker);
  if ('code' in resolved) return resolved;
  const { tmux_name } = resolved.meta;

  const stdout = `The worker is running in tmux session '${tmux_name}'. To take over:

    tmux attach -t ${tmux_name}

Once attached, you can type to the worker directly. Detach with Ctrl-B d to
return without ending the session.

Leave the worker running. The controller can resume by sending another
prompt — do not run $WORKER stop unless you actually want to terminate
the session.
`;
  return { stdout, code: 0 };
}
