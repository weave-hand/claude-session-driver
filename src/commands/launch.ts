import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasConsent } from '../core/consent.js';
import { ensureBackCompatSymlink, eventsPath } from '../core/paths.js';
import { writeMeta, writeShim } from '../core/worker-store.js';
import type { HarnessId } from '../harness/driver.js';
import { getDriver } from '../harness/registry.js';
import { awaitSessionStart } from './await-start.js';
import type { CommandContext, CommandResult } from './context.js';

/**
 * Shell-quote a single token for the reproduce line. A simplified port of
 * bash `printf %q`: tokens of only safe characters pass through unquoted;
 * anything else is wrapped in single quotes (with embedded single quotes
 * escaped the `'\''` way). The goal is a copy-pasteable command, not byte
 * parity with %q.
 */
export function shellQuote(token: string): string {
  if (token === '') return "''";
  if (/^[A-Za-z0-9_./:=@-]+$/.test(token)) return token;
  return `'${token.replaceAll("'", "'\\''")}'`;
}

/** The shared bootstrap options launch and adopt both accept. */
export interface BootstrapOpts {
  /** Plugin root, passed to the harness via `--plugin-dir`. */
  pluginDir: string;
  /** Absolute path to the csd entry (dist/csd.cjs) baked into each worker shim. */
  csdEntry: string;
  /** The csd command path used in the reproduce line + consent message. */
  csdPath: string;
  /** awaitSessionStart timing overrides (tests pass tiny values). */
  trustTimeoutMs?: number;
  startTimeoutMs?: number;
  pollMs?: number;
}

export interface LaunchArgs {
  tmuxName: string;
  cwd: string;
  extraArgs: string[];
  /** The harness to launch; the command resolves its own driver from this. */
  harness: HarnessId;
}

/** The one-time-consent error, matching the bash text. */
export function consentError(csdPath: string): CommandResult {
  return {
    stderr: `Error: claude-session-driver requires one-time consent before launching workers.\nRun: ${csdPath} grant-consent`,
    code: 1,
  };
}

/**
 * Validate that cwd is an existing directory and resolve it to an absolute
 * realpath (bash `pwd -P`). Returns the resolved path, or a code-1 result.
 */
export function resolveCwd(cwd: string): string | CommandResult {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return { stderr: `Error: cwd '${cwd}' does not exist`, code: 1 };
  }
  return realpathSync(cwd);
}

/** Render the status panel printed to stderr by launch/adopt. */
export function renderPanel(opts: {
  header: string;
  verb: string;
  tmuxName: string;
  sessionId: string;
  cwd: string;
  eventsFile: string;
  csdPath: string;
  invocation: string[];
}): string {
  const reproduceArgs = opts.invocation.map(shellQuote).join(' ');
  return [
    opts.header,
    `  tmux:       ${opts.tmuxName}`,
    `  session_id: ${opts.sessionId}`,
    `  cwd:        ${opts.cwd}`,
    `  events:     ${opts.eventsFile}`,
    `  reproduce: ${shellQuote(opts.csdPath)} ${opts.verb} ${reproduceArgs}`,
  ].join('\n');
}

/**
 * Launch a fresh worker. Parity port of bash `cmd_launch` (csd:704-790).
 *
 * The harness is chosen here, so launch resolves its OWN driver from `harness`
 * (ignoring `ctx.driver`). The driver `prepare`/`postLaunch` seams are invoked
 * around the tmux start (no-ops for claude today; real for codex/pi later). The
 * claude proof-of-life wait (trust dialog + session_start) is orchestrated by
 * `awaitSessionStart`, which needs `ctx.tmux`/`ctx.workerDir` the driver slots
 * don't receive; Phase B/C will route this through the driver for codex/pi.
 */
export async function cmdLaunch(
  ctx: CommandContext,
  args: LaunchArgs,
  opts: BootstrapOpts,
): Promise<CommandResult> {
  const { tmuxName, extraArgs } = args;
  const driver = getDriver(args.harness);

  const resolved = resolveCwd(args.cwd);
  if (typeof resolved !== 'string') return resolved;
  const cwd = resolved;

  if (!hasConsent(ctx.home)) return consentError(opts.csdPath);

  if (await ctx.tmux.hasSession(tmuxName)) {
    return {
      stderr: `Error: tmux session '${tmuxName}' already exists`,
      code: 1,
    };
  }

  const sessionId = randomUUID();

  // Worker dir + bin dir must exist before writing meta/shim.
  mkdirSync(ctx.workerDir, { recursive: true });
  mkdirSync(join(ctx.workerDir, 'bin'), { recursive: true });
  ensureBackCompatSymlink(ctx.workerDir);

  const env = driver.workerEnv(process.env);
  await driver.prepare(tmuxName, cwd, ctx.home);

  const argv = [
    ...driver.launchArgv('launch', sessionId, cwd, opts.pluginDir, ctx.home),
    ...extraArgs,
  ];
  await ctx.tmux.newSession(tmuxName, cwd, env, argv);

  await driver.postLaunch(tmuxName);

  const proof = await awaitSessionStart(ctx, tmuxName, sessionId, opts);
  if (!proof.started) {
    return { stderr: proof.failureMessage, code: 1 };
  }

  const invocation =
    extraArgs.length > 0
      ? [tmuxName, cwd, '--', ...extraArgs]
      : [tmuxName, cwd];

  writeMeta(ctx.workerDir, {
    tmux_name: tmuxName,
    session_id: sessionId,
    cwd,
    harness: driver.id,
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    invocation,
  });

  const shim = writeShim(ctx.workerDir, tmuxName, opts.csdEntry);
  const panel = renderPanel({
    header: 'Worker launched.',
    verb: 'launch',
    tmuxName,
    sessionId,
    cwd,
    eventsFile: eventsPath(ctx.workerDir, sessionId),
    csdPath: opts.csdPath,
    invocation,
  });

  return { stdout: shim, stderr: panel, code: 0 };
}
