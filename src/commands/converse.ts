import { existsSync, readFileSync } from 'node:fs';
import {
  countAssistantTextMessages,
  lastAssistantText,
} from '../core/assistant-text.js';
import { dumpConverseDiag } from '../core/diagnostics.js';
import { readRawLines } from '../core/event-log.js';
import { eventsPath } from '../core/paths.js';
import type { Runner } from '../core/proc.js';
import type { CommandContext, CommandResult } from './context.js';
import { resolveWorker } from './context.js';
import { cmdReadTurn } from './read-turn.js';
import { cmdSend, type SendOpts } from './send.js';
import { cmdWaitForTurn } from './wait-for-turn.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface ConverseOpts {
  /** Render the full markdown turn instead of just the last assistant text. */
  withTurn?: boolean;
  /** Wait-for-turn timeout in SECONDS (default 120). */
  timeout?: number;
  /** Knobs forwarded to cmdSend (keeps submission confirm fast in tests). */
  sendOpts?: SendOpts;
  /** Poll interval forwarded to cmdWaitForTurn, ms. */
  waitPollMs?: number;
  /** Post-turn assistant-text poll attempts (default 20). */
  postPollCount?: number;
  /** Post-turn poll interval, ms (default 100). */
  postPollMs?: number;
  /** Injectable timestamp for diagnostics (default ISO now). */
  now?: () => string;
  /** Injectable process runner for the diagnostics ps dump. */
  diagRun?: Runner;
}

/**
 * Read the transcript file (or '' if absent) at the given path.
 */
function readTranscript(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Send a prompt to a worker, wait for the turn to finish, and return the
 * worker's reply.
 *
 * Parity port of bash `cmd_converse`. Reuses `cmdSend`, `cmdWaitForTurn`, and
 * (for `--with-turn`) `cmdReadTurn`. Records the assistant-text-message count
 * before sending; after the turn ends, polls the transcript for a NEW assistant
 * text message and returns either the rendered markdown turn (`withTurn`) or the
 * last assistant text. On a wait-for-turn timeout or a no-new-response timeout,
 * dumps a diagnostic when `CSD_CONVERSE_DIAG_FILE` is set.
 */
export async function cmdConverse(
  ctx: CommandContext,
  worker: string,
  prompt: string,
  opts: ConverseOpts,
): Promise<CommandResult> {
  const resolved = resolveWorker(ctx, worker);
  if ('code' in resolved) return resolved;
  const { sid, meta } = resolved;

  if (!meta.cwd) {
    return {
      stderr: 'Error: Could not determine working directory from meta file',
      code: 1,
    };
  }

  const timeout = opts.timeout ?? 120;
  const postPollCount = opts.postPollCount ?? 20;
  const postPollMs = opts.postPollMs ?? 100;
  const now = opts.now ?? (() => new Date().toISOString());

  const logFile = ctx.driver.transcriptPath(sid, meta.cwd, ctx.home);
  const eventFile = eventsPath(ctx.workerDir, sid);

  const beforeCount = countAssistantTextMessages(readTranscript(logFile));
  const afterLine = readRawLines(eventFile).length;

  const sendResult = await cmdSend(ctx, worker, prompt, opts.sendOpts ?? {});
  if (sendResult.code !== 0) return sendResult;

  const diagDest = process.env.CSD_CONVERSE_DIAG_FILE;
  const dumpDiag = async (reason: string): Promise<string> => {
    if (!diagDest) return '';
    const ok = await dumpConverseDiag({
      sid,
      worker,
      tmuxName: meta.tmux_name,
      logFile,
      eventFile,
      timeout,
      dest: diagDest,
      reason,
      tmux: ctx.tmux,
      now,
      run: opts.diagRun,
    });
    return ok ? `\ncsd-diagnostic: ${diagDest}` : '';
  };

  const waitResult = await cmdWaitForTurn(ctx, worker, {
    timeout,
    afterLine,
    pollMs: opts.waitPollMs,
  });
  if (waitResult.code !== 0) {
    const diag = await dumpDiag('wait_for_turn_timeout');
    return {
      stderr: `Error: Worker did not finish within ${timeout}s${diag}`,
      code: 1,
    };
  }

  for (let i = 0; i < postPollCount; i++) {
    const transcript = readTranscript(logFile);
    if (transcript.length > 0) {
      const afterCount = countAssistantTextMessages(transcript);
      if (afterCount > beforeCount) {
        if (opts.withTurn) {
          return cmdReadTurn(ctx, worker, { full: false });
        }
        const response = lastAssistantText(transcript);
        if (response.length > 0) {
          return { stdout: response, code: 0 };
        }
      }
    }
    await sleep(postPollMs);
  }

  const diag = await dumpDiag('no_assistant_response');
  return {
    stderr: `Error: Timed out waiting for assistant response in session log${diag}`,
    code: 1,
  };
}
