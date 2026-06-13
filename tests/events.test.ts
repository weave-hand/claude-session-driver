import { describe, expect, it } from 'vitest';
import { parseEvent, serializeEvent, type WorkerEvent } from '../src/events.js';

describe('events', () => {
  it('round-trips a pre_tool_use event', () => {
    const e: WorkerEvent = {
      event: 'pre_tool_use',
      ts: 'T',
      tool: 'Bash',
      tool_input: { cmd: 'ls' },
    };
    expect(parseEvent(serializeEvent(e))).toEqual(e);
  });
  it('parses a session_start with cwd', () => {
    expect(parseEvent('{"event":"session_start","ts":"T","cwd":"/x"}')).toEqual(
      {
        event: 'session_start',
        ts: 'T',
        cwd: '/x',
      },
    );
  });
  it('returns null for malformed json or unknown event', () => {
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent('{"event":"nope","ts":"T"}')).toBeNull();
  });
});
