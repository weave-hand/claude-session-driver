import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { WorkerEvent } from '../events.js';
import { parseEvent, serializeEvent } from '../events.js';

export type WorkerStatus =
  | 'idle'
  | 'working'
  | 'terminated'
  | 'gone'
  | 'unknown';

/** Read the raw, non-empty JSONL lines of an events file. Returns [] if the file does not exist. */
export function readRawLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

export function appendEvent(file: string, e: WorkerEvent): void {
  appendFileSync(file, `${serializeEvent(e)}\n`);
}

export function readEvents(file: string): WorkerEvent[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parseEvent)
    .filter((e): e is WorkerEvent => e !== null);
}

export function lastEvent(file: string): WorkerEvent | null {
  const events = readEvents(file);
  return events.at(-1) ?? null;
}

export async function waitForEvent(
  file: string,
  pred: (e: WorkerEvent) => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<WorkerEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = readEvents(file).find(pred);
    if (match !== undefined) return match;
    if (Date.now() >= deadline) {
      throw new Error(`waitForEvent timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function classifyStatus(last: WorkerEvent): WorkerStatus {
  switch (last.event) {
    case 'session_end':
      return 'terminated';
    case 'user_prompt_submit':
    case 'pre_tool_use':
    case 'post_tool_use':
      return 'working';
    case 'stop':
    case 'session_start':
      return 'idle';
    default: {
      const _exhaustive: never = last;
      return _exhaustive;
    }
  }
}
