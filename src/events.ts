export type WorkerEvent =
  | { event: 'session_start'; ts: string; cwd?: string }
  | { event: 'user_prompt_submit'; ts: string }
  | { event: 'pre_tool_use'; ts: string; tool: string; tool_input: unknown }
  | { event: 'post_tool_use'; ts: string; tool: string }
  | { event: 'stop'; ts: string }
  | { event: 'session_end'; ts: string };

export type EventName = WorkerEvent['event'];

export const EVENT_NAMES: readonly EventName[] = [
  'session_start',
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'stop',
  'session_end',
];

export function serializeEvent(e: WorkerEvent): string {
  return JSON.stringify(e);
}

export function parseEvent(line: string): WorkerEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const event = (v as { event?: unknown }).event;
  if (typeof event !== 'string' || !EVENT_NAMES.includes(event as EventName))
    return null;
  return v as WorkerEvent;
}
