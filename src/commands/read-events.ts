import { existsSync, readFileSync } from 'node:fs';
import { eventsPath } from '../core/paths.js';
import { resolveSession } from '../core/worker-store.js';
import { EVENT_NAMES, type EventName, parseEvent } from '../events.js';
import type { CommandContext, CommandResult } from './context.js';

export interface ReadEventsOpts {
  last?: number;
  type?: string;
  follow?: boolean;
}

/** Read the raw, non-empty JSONL lines of an events file. */
function readRawLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Keep only the raw lines whose parsed `.event` equals `type`. */
function filterByType(lines: string[], type: string): string[] {
  return lines.filter((line) => parseEvent(line)?.event === type);
}

function isKnownEvent(type: string): type is EventName {
  return (EVENT_NAMES as readonly string[]).includes(type);
}

/**
 * Read events from a worker's event file (non-follow path). Emits the RAW JSONL
 * lines so a consumer gets exactly what's in the file; the `--type` filter
 * parses each line only to check its `.event`, but emits the original raw line.
 *
 * `--follow` is a streaming command (tail -f) and is NOT handled here — the CLI
 * calls `followEvents` directly for follow. A `follow: true` opt is ignored by
 * this function.
 */
export async function cmdReadEvents(
  ctx: CommandContext,
  worker: string,
  opts: ReadEventsOpts,
): Promise<CommandResult> {
  if (opts.type !== undefined && !isKnownEvent(opts.type)) {
    return {
      stderr: `Error: '${opts.type}' is not a known event type. Valid events: ${EVENT_NAMES.join(' ')}`,
      code: 2,
    };
  }

  const sid = resolveSession(ctx.workerDir, worker);
  if (sid === null) {
    return { stderr: `Error: no worker known as '${worker}'`, code: 1 };
  }

  const eventFile = eventsPath(ctx.workerDir, sid);
  if (!existsSync(eventFile)) {
    return { stderr: `Error: No event file for session ${sid}`, code: 1 };
  }

  let lines = readRawLines(eventFile);
  if (opts.type !== undefined) {
    lines = filterByType(lines, opts.type);
  }
  if (opts.last !== undefined) {
    lines = lines.slice(-opts.last);
  }
  return { stdout: lines.join('\n'), code: 0 };
}

export interface FollowEventsOpts {
  type?: string;
  pollMs?: number;
}

/**
 * Tail a worker's event file: emit every raw line (including ones already
 * present at start), then poll for newly appended lines and emit those, until
 * `signal` aborts. With a `type` filter, only matching lines reach `sink`.
 *
 * The CLI wires `sink` to `process.stdout.write` and runs this until SIGINT.
 * Unlike `cmdReadEvents`, this never validates the type (the CLI validates
 * up front) — an unknown type simply matches nothing.
 */
export async function followEvents(
  ctx: CommandContext,
  worker: string,
  opts: FollowEventsOpts,
  sink: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const pollMs = opts.pollMs ?? 250;
  const sid = resolveSession(ctx.workerDir, worker);
  if (sid === null) return;
  const eventFile = eventsPath(ctx.workerDir, sid);

  let emitted = 0;
  for (;;) {
    if (signal?.aborted) return;
    if (existsSync(eventFile)) {
      const lines = readRawLines(eventFile);
      for (const line of lines.slice(emitted)) {
        if (opts.type === undefined || parseEvent(line)?.event === opts.type) {
          sink(line);
        }
      }
      emitted = lines.length;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
