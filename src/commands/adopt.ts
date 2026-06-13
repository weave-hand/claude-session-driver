import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasConsent } from '../core/consent.js';
import { ensureBackCompatSymlink, eventsPath } from '../core/paths.js';
import { isoSecondsUtc } from '../core/time.js';
import { writeMeta, writeShim } from '../core/worker-store.js';
import { getDriver } from '../harness/registry.js';
import { awaitSessionStart } from './await-start.js';
import type { CommandContext, CommandResult } from './context.js';
import {
  type BootstrapOpts,
  consentError,
  renderPanel,
  resolveCwd,
} from './launch.js';

/** Claude session ids are UUID-ish: hex + dashes (bash csd:818). */
const CLAUDE_SESSION_ID = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;

export interface AdoptArgs {
  tmuxName: string;
  cwd: string;
  /** The existing Claude session id to resume. */
  sessionId: string;
  extraArgs: string[];
}

/**
 * Re-attach to an existing Claude session after a reboot. Parity port of bash
 * `cmd_adopt` (csd:791-905). Claude-only: there is no `--harness` flag, so the
 * driver is always claude.
 *
 * `claude --resume <id>` preserves the session id, so the worker's runtime
 * session_id equals the supplied id. The meta is pre-written keyed by that id
 * BEFORE claude starts, because the SessionStart hook only records events once a
 * meta exists for the session. If a tmux session already exists (e.g. restored
 * by tmux-resurrect), its pane is respawned in place to preserve the window
 * layout; otherwise a new detached session is opened.
 *
 * The proof-of-life wait and its teardown-on-timeout mirror launch; see
 * `cmdLaunch` for the driver-orchestration notes.
 */
export async function cmdAdopt(
  ctx: CommandContext,
  args: AdoptArgs,
  opts: BootstrapOpts,
): Promise<CommandResult> {
  const { tmuxName, sessionId, extraArgs } = args;
  const driver = getDriver('claude');

  const resolved = resolveCwd(args.cwd);
  if (typeof resolved !== 'string') return resolved;
  const cwd = resolved;

  if (!CLAUDE_SESSION_ID.test(sessionId)) {
    return {
      stderr: `Error: '${sessionId}' does not look like a Claude session id`,
      code: 1,
    };
  }

  if (!hasConsent(ctx.home)) return consentError(opts.csdPath);

  mkdirSync(ctx.workerDir, { recursive: true });
  mkdirSync(join(ctx.workerDir, 'bin'), { recursive: true });
  ensureBackCompatSymlink(ctx.workerDir);

  const invocation =
    extraArgs.length > 0
      ? [tmuxName, cwd, sessionId, '--', ...extraArgs]
      : [tmuxName, cwd, sessionId];

  // Pre-write the meta keyed by sessionId so the SessionStart hook can record
  // events the moment claude starts.
  writeMeta(ctx.workerDir, {
    tmux_name: tmuxName,
    session_id: sessionId,
    cwd,
    harness: driver.id,
    started_at: isoSecondsUtc(),
    invocation,
  });

  const env = driver.workerEnv(process.env);
  await driver.prepare(tmuxName, cwd, ctx.home);

  const argv = [
    ...driver.launchArgv('adopt', sessionId, cwd, opts.pluginDir, ctx.home),
    ...extraArgs,
  ];

  let mode: string;
  if (await ctx.tmux.hasSession(tmuxName)) {
    mode = 'respawned existing pane';
    await ctx.tmux.respawnPane(tmuxName, cwd, env, argv);
  } else {
    mode = 'opened new pane';
    await ctx.tmux.newSession(tmuxName, cwd, env, argv);
  }

  await driver.postLaunch(tmuxName);

  const proof = await awaitSessionStart(ctx, tmuxName, sessionId, opts);
  if (!proof.started) {
    return { stderr: proof.failureMessage, code: 1 };
  }

  const shim = writeShim(ctx.workerDir, tmuxName, opts.csdEntry);
  const panel = renderPanel({
    header: `Worker adopted (${mode}).`,
    verb: 'adopt',
    tmuxName,
    sessionId,
    cwd,
    eventsFile: eventsPath(ctx.workerDir, sessionId),
    csdPath: opts.csdPath,
    invocation,
  });

  return { stdout: shim, stderr: panel, code: 0 };
}
