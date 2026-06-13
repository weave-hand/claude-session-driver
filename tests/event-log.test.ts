import { describe, expect, it } from 'vitest';
import { classifyStatus } from '../src/core/event-log.js';
import type { WorkerEvent } from '../src/events.js';

const ev = (event: WorkerEvent['event']): WorkerEvent =>
  (event === 'pre_tool_use'
    ? { event, ts: 'T', tool: 'Bash', tool_input: {} }
    : event === 'post_tool_use'
      ? { event, ts: 'T', tool: 'Bash' }
      : { event, ts: 'T' }) as WorkerEvent;

describe('classifyStatus', () => {
  it('working for prompt/pre/post tool use', () => {
    for (const e of [
      'user_prompt_submit',
      'pre_tool_use',
      'post_tool_use',
    ] as const)
      expect(classifyStatus(ev(e))).toBe('working');
  });
  it('idle for stop/session_start', () => {
    expect(classifyStatus(ev('stop'))).toBe('idle');
    expect(classifyStatus(ev('session_start'))).toBe('idle');
  });
  it('terminated for session_end', () => {
    expect(classifyStatus(ev('session_end'))).toBe('terminated');
  });
});
