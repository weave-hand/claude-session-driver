import { resolveSession } from '../core/worker-store.js';
import type { CommandContext, CommandResult } from './context.js';

export async function cmdSessionId(
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
  return { stdout: sid, code: 0 };
}
