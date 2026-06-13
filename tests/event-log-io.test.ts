import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  lastEvent,
  readEvents,
  waitForEvent,
} from '../src/core/event-log.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'csd-')), 'e.jsonl');
}

it('appends and reads events, skipping malformed lines', () => {
  const f = tmpFile();
  appendEvent(f, { event: 'session_start', ts: 'T', cwd: '/x' });
  writeFileSync(f, 'garbage\n', { flag: 'a' });
  appendEvent(f, { event: 'stop', ts: 'T' });
  expect(readEvents(f).map((e) => e.event)).toEqual(['session_start', 'stop']);
  expect(lastEvent(f)?.event).toBe('stop');
});

describe('lastEvent', () => {
  it('returns null for a missing file', () => {
    expect(lastEvent('/nonexistent/path/to/missing.jsonl')).toBeNull();
  });

  it('returns null for an empty file', () => {
    const f = tmpFile();
    writeFileSync(f, '');
    expect(lastEvent(f)).toBeNull();
  });

  it('returns the last valid event', () => {
    const f = tmpFile();
    appendEvent(f, { event: 'session_start', ts: 'T1' });
    appendEvent(f, { event: 'stop', ts: 'T2' });
    expect(lastEvent(f)?.event).toBe('stop');
  });
});

describe('readEvents', () => {
  it('returns empty array for missing file', () => {
    expect(readEvents('/nonexistent/path/to/missing.jsonl')).toEqual([]);
  });
});

describe('waitForEvent', () => {
  it('resolves promptly when a matching event is already present', async () => {
    const f = tmpFile();
    appendEvent(f, { event: 'session_start', ts: 'T' });
    const e = await waitForEvent(
      f,
      (ev) => ev.event === 'session_start',
      1000,
      50,
    );
    expect(e.event).toBe('session_start');
  });

  it('resolves when a matching event is written after polling starts', async () => {
    const f = tmpFile();
    setTimeout(() => appendEvent(f, { event: 'stop', ts: 'T' }), 80);
    const e = await waitForEvent(f, (ev) => ev.event === 'stop', 2000, 50);
    expect(e.event).toBe('stop');
  });

  it('rejects with a timeout error when no match appears', async () => {
    const f = tmpFile();
    await expect(
      waitForEvent(f, (ev) => ev.event === 'session_start', 100, 20),
    ).rejects.toThrow('100');
  });
});
