/**
 * The Claude Code harness driver. Parity port of the bash `claude.sh` driver
 * (skills/driving-claude-code-sessions/scripts/drivers/claude.sh).
 *
 * Claude's control plane is hooks; the controller assigns the session id; quit
 * is `/exit`. `prepare`/`postLaunch`/`awaitReady` are no-ops here — the launch
 * command (A11j) owns Claude's trust-dialog handling and the
 * await-session-start wait, since those need the full launch-time context.
 */

import { claudeTranscriptPath } from '../core/paths.js';
import { type NormalizedTurn, parseClaudeTurn } from '../core/transcript.js';
import type { HarnessDriver, LaunchMode } from './driver.js';

/**
 * Provider/auth vars Claude resolves directly from the process env (issue #18).
 * A new tmux session inherits the tmux SERVER's global env, not this process's,
 * so a stale global `CLAUDE_CODE_USE_BEDROCK=1` could otherwise hijack a worker
 * onto an expired provider. We pin each var empty in the worker env when the
 * controller does NOT have a non-empty value for it (killing the stale value),
 * and leave it OUT when the controller genuinely uses it (so the real provider
 * and its credentials inherit together through tmux).
 */
const CLAUDE_PROVIDER_ENV_VARS = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
] as const;

/**
 * Build the `-e KEY=VALUE` pins for a Claude worker's tmux env, as a record
 * (tmux.newSession expands a record into `-e K=V` pairs; an empty-string value
 * becomes `-e VAR=`, which is exactly the pin-empty behaviour).
 *
 * `CLAUDE_CODE_SSE_PORT` is always pinned empty: it is the IDE socket port, only
 * ever a UI channel and never an auth channel, so a headless worker must not
 * auto-connect to the controller's IDE socket.
 *
 * `IS_DEMO` is pinned to `1` so a fresh `--session-id` worker skips first-run
 * onboarding — specifically the terminal-scoped theme picker, which re-prompts
 * on every new session id regardless of global `hasCompletedOnboarding`, and
 * otherwise stalls the worker before `session_start` (issue #11).
 */
export function claudeWorkerEnv(
  controllerEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_SSE_PORT: '',
    IS_DEMO: '1',
  };
  for (const name of CLAUDE_PROVIDER_ENV_VARS) {
    if (!controllerEnv[name]) env[name] = '';
  }
  return env;
}

export const claude: HarnessDriver = {
  id: 'claude',
  controlPlane: 'hooks',
  idStrategy: 'assign',
  quitKeys: '/exit',

  bin(): string {
    return process.env.CSD_CLAUDE_BIN ?? 'claude';
  },

  // Claude's worker HOME is the controller HOME, so `workerHome` is ignored;
  // the param exists because codex's env depends on its per-worker CODEX_HOME.
  // `tmuxName` is ignored: claude carries its name in the pre-written meta.
  workerEnv(
    _workerHome: string,
    _tmuxName: string,
    controllerEnv: NodeJS.ProcessEnv = process.env,
  ): Record<string, string> {
    return claudeWorkerEnv(controllerEnv);
  },

  launchArgv(
    mode: LaunchMode,
    sessionId: string,
    _cwd: string,
    pluginDir: string,
    _workerHome: string,
  ): string[] {
    const idFlag = mode === 'adopt' ? '--resume' : '--session-id';
    return [
      this.bin(),
      idFlag,
      sessionId,
      '--plugin-dir',
      pluginDir,
      '--settings',
      '{"skipDangerousModePermissionPrompt":true}',
      '--dangerously-skip-permissions',
      '--disallowed-tools',
      'AskUserQuestion',
    ];
  },

  // Claude needs no per-worker prep and no post-launch gate dismissal; its
  // trust-dialog and await-session-start orchestration live in the launch
  // command. These slots exist for harnesses (codex/pi) that do need them.
  async prepare(
    _tmuxName: string,
    _cwd: string,
    _workerHome: string,
  ): Promise<void> {},

  async postLaunch(_tmuxName: string): Promise<void> {},

  async awaitReady(_tmuxName: string, _sessionId: string): Promise<void> {},

  transcriptPath(sessionId: string, cwd: string, workerHome: string): string {
    return claudeTranscriptPath(workerHome, cwd, sessionId);
  },

  parseTurn(transcript: string): NormalizedTurn {
    return parseClaudeTurn(transcript);
  },
};
