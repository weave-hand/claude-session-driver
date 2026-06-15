/**
 * The converse post-mortem diagnostic dump. A parity port of the bash
 * `_dump_converse_diag` (skills/driving-claude-code-sessions/scripts/csd).
 *
 * Best-effort: writes a multi-section snapshot (ps tree + tmux capture + harness
 * JSONL tail + csd events tail) to `dest`, OVERWRITING it. Returns true on a
 * successful write, false if the dir-create or write fails — so the caller can
 * suppress its "see <dest>" pointer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Runner, run as realRun } from './proc.js';
import type { Tmux } from './tmux.js';

export interface ConverseDiagOpts {
  sid: string;
  worker: string;
  tmuxName: string;
  logFile: string;
  eventFile: string;
  timeout: number;
  dest: string;
  reason: string;
  tmux: Tmux;
  /** Injectable timestamp (e.g. `() => new Date().toISOString()`). */
  now: () => string;
  /** Process runner used for `ps`; injectable so tests can stub it. */
  run?: Runner;
}

/** Mirror `tail -n n`: the last `n` lines, ignoring a single trailing newline. */
function tailLines(text: string, n: number): string {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (trimmed.length === 0) return '';
  return trimmed.split('\n').slice(-n).join('\n');
}

/**
 * Render a caught value as a short reason. A diagnostic probe must never fail
 * silently: an empty section is indistinguishable from "captured, nothing to
 * show", which is how a whole-OS breakage (a host-rejected `ps` flag) can hide.
 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Best-effort `ps -eo ...` list, tail 100. `-eo` is portable; the GNU `-H`
 * (forest) flag is rejected by BSD/macOS ps (csd's primary platform) and would
 * blank this section. `pid,ppid` still let a reader reconstruct parentage.
 */
async function psTree(run: Runner): Promise<string> {
  try {
    const r = await run('ps', ['-eo', 'pid,ppid,stat,etime,comm']);
    return tailLines(r.stdout, 100);
  } catch (e) {
    return `(ps failed: ${errText(e)})`;
  }
}

/** Capture the pane (full scrollback, tail 200), or a not-present/failure note. */
async function paneCapture(tmux: Tmux, tmuxName: string): Promise<string> {
  if (!(await tmux.hasSession(tmuxName))) {
    return `(tmux session '${tmuxName}' not present)`;
  }
  try {
    return tailLines(await tmux.capturePaneFull(tmuxName), 200);
  } catch (e) {
    return `(pane capture failed: ${errText(e)})`;
  }
}

/** Tail a file's last `n` lines, or a not-present/failure note. */
function fileTail(file: string, n: number, missingNote: string): string {
  if (!existsSync(file)) return missingNote;
  try {
    return tailLines(readFileSync(file, 'utf8'), n);
  } catch (e) {
    return `(read failed: ${errText(e)})`;
  }
}

export async function dumpConverseDiag(
  opts: ConverseDiagOpts,
): Promise<boolean> {
  const run = opts.run ?? realRun;

  try {
    mkdirSync(dirname(opts.dest), { recursive: true });
  } catch {
    return false;
  }

  const sections = [
    `=== csd converse diagnostic (${opts.now()}) ===`,
    `reason=${opts.reason}`,
    `session_id=${opts.sid} worker=${opts.worker} tmux_name=${opts.tmuxName} timeout=${opts.timeout}s`,
    `log_file=${opts.logFile}`,
    `event_file=${opts.eventFile}`,
    '',
    '--- ps -eo pid,ppid,stat,etime,comm (last 100 lines) ---',
    await psTree(run),
    '',
    `--- tmux capture-pane -t ${opts.tmuxName} (full scrollback, tail 200) ---`,
    await paneCapture(opts.tmux, opts.tmuxName),
    '',
    `--- claude session JSONL tail (last 30 lines from ${opts.logFile}) ---`,
    fileTail(opts.logFile, 30, '(log file not present)'),
    '',
    `--- csd events JSONL tail (last 20 lines from ${opts.eventFile}) ---`,
    fileTail(opts.eventFile, 20, '(event file not present)'),
    '',
    '=== end csd diagnostic ===',
  ];

  try {
    writeFileSync(opts.dest, `${sections.join('\n')}\n`);
  } catch {
    return false;
  }
  return true;
}
