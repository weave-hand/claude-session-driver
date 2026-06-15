import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdReadEvents, followEvents } from '../src/commands/read-events.js';
import { appendEvent } from '../src/core/event-log.js';
import { eventsPath } from '../src/core/paths.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-readev-'));
}

const BASE_META = {
  tmux_name: 'my-worker',
  session_id: 'sid-readev',
  cwd: '/home/user/project',
  harness: 'claude',
};

function makeCtx(workerDir: string): CommandContext {
  return {
    workerDir,
    home: workerDir,
    tmux: makeTmux(async () => ({ stdout: '', stderr: '', code: 0 })),
    driver: getDriver('claude'),
  };
}

function seedEvents(workerDir: string): string {
  const ef = eventsPath(workerDir, 'sid-readev');
  appendEvent(ef, { event: 'session_start', ts: '2025-01-01T00:00:00Z' });
  appendEvent(ef, { event: 'user_prompt_submit', ts: '2025-01-01T00:00:01Z' });
  appendEvent(ef, {
    event: 'pre_tool_use',
    ts: '2025-01-01T00:00:02Z',
    tool: 'Bash',
    tool_input: {},
  });
  appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:03Z' });
  return ef;
}

describe('cmdReadEvents', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, BASE_META);
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('returns all raw lines when no options given', async () => {
    const ef = seedEvents(workerDir);
    const result = await cmdReadEvents(makeCtx(workerDir), 'sid-readev', {});
    expect(result.code).toBe(0);
    // raw JSONL lines, exactly as written
    const lines = (result.stdout ?? '').split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      '{"event":"session_start","ts":"2025-01-01T00:00:00Z"}',
    );
    expect(lines[3]).toBe('{"event":"stop","ts":"2025-01-01T00:00:03Z"}');
    void ef;
  });

  it('returns the last N lines with --last', async () => {
    seedEvents(workerDir);
    const result = await cmdReadEvents(makeCtx(workerDir), 'sid-readev', {
      last: 2,
    });
    expect(result.code).toBe(0);
    const lines = (result.stdout ?? '').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"event":"pre_tool_use"');
    expect(lines[1]).toContain('"event":"stop"');
  });

  it('returns NOTHING with --last 0 (bash tail -n 0), not all lines', async () => {
    seedEvents(workerDir);
    const result = await cmdReadEvents(makeCtx(workerDir), 'sid-readev', {
      last: 0,
    });
    expect(result.code).toBe(0);
    // slice(-0) === slice(0) === all lines; the guard must yield empty instead.
    expect(result.stdout).toBe('');
  });

  it('filters by --type, emitting only matching raw lines', async () => {
    seedEvents(workerDir);
    const result = await cmdReadEvents(makeCtx(workerDir), 'sid-readev', {
      type: 'stop',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"event":"stop","ts":"2025-01-01T00:00:03Z"}');
  });

  it('combines --type and --last (type filter first, then last N)', async () => {
    const ef = eventsPath(workerDir, 'sid-readev');
    appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:00Z' });
    appendEvent(ef, {
      event: 'user_prompt_submit',
      ts: '2025-01-01T00:00:01Z',
    });
    appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:02Z' });
    appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:03Z' });
    const result = await cmdReadEvents(makeCtx(workerDir), 'sid-readev', {
      type: 'stop',
      last: 2,
    });
    expect(result.code).toBe(0);
    const lines = (result.stdout ?? '').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"event":"stop","ts":"2025-01-01T00:00:02Z"}');
    expect(lines[1]).toBe('{"event":"stop","ts":"2025-01-01T00:00:03Z"}');
  });

  it('returns code 2 for an unknown event type', async () => {
    seedEvents(workerDir);
    const result = await cmdReadEvents(makeCtx(workerDir), 'sid-readev', {
      type: 'bogus',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("'bogus' is not a known event type");
    expect(result.stderr).toContain('Valid events:');
  });

  it('returns code 1 when no event file exists', async () => {
    const result = await cmdReadEvents(makeCtx(workerDir), 'sid-readev', {});
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Error: No event file for session sid-readev');
  });

  it('returns code 1 for an unknown worker', async () => {
    const result = await cmdReadEvents(makeCtx(workerDir), 'ghost', {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ghost');
  });

  it('emits raw lines verbatim even when they contain extra fields', async () => {
    const ef = eventsPath(workerDir, 'sid-readev');
    // A raw line with an extra field that re-serialization would reorder/drop.
    writeFileSync(
      ef,
      '{"event":"stop","ts":"2025-01-01T00:00:00Z","extra":"keep-me"}\n',
    );
    const result = await cmdReadEvents(makeCtx(workerDir), 'sid-readev', {
      type: 'stop',
    });
    expect(result.stdout).toBe(
      '{"event":"stop","ts":"2025-01-01T00:00:00Z","extra":"keep-me"}',
    );
  });
});

describe('followEvents', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, BASE_META);
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('streams new lines appended after start, then stops on abort', async () => {
    const ef = eventsPath(workerDir, 'sid-readev');
    // pre-existing line is also emitted (tail emits the whole file from line 0)
    appendEvent(ef, { event: 'session_start', ts: '2025-01-01T00:00:00Z' });

    const received: string[] = [];
    const ctrl = new AbortController();
    const done = followEvents(
      makeCtx(workerDir),
      'sid-readev',
      { pollMs: 10 },
      (line) => received.push(line),
      ctrl.signal,
    );

    // give the follower a couple of poll cycles, then append more lines
    await new Promise((r) => setTimeout(r, 40));
    appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:01Z' });
    await new Promise((r) => setTimeout(r, 40));
    appendEvent(ef, { event: 'session_end', ts: '2025-01-01T00:00:02Z' });
    await new Promise((r) => setTimeout(r, 40));

    ctrl.abort();
    await done;

    expect(received).toContain(
      '{"event":"session_start","ts":"2025-01-01T00:00:00Z"}',
    );
    expect(received).toContain('{"event":"stop","ts":"2025-01-01T00:00:01Z"}');
    expect(received).toContain(
      '{"event":"session_end","ts":"2025-01-01T00:00:02Z"}',
    );
  });

  it('applies the --type filter while following', async () => {
    const ef = eventsPath(workerDir, 'sid-readev');
    const received: string[] = [];
    const ctrl = new AbortController();
    const done = followEvents(
      makeCtx(workerDir),
      'sid-readev',
      { type: 'stop', pollMs: 10 },
      (line) => received.push(line),
      ctrl.signal,
    );

    await new Promise((r) => setTimeout(r, 20));
    appendEvent(ef, {
      event: 'user_prompt_submit',
      ts: '2025-01-01T00:00:00Z',
    });
    appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:01Z' });
    await new Promise((r) => setTimeout(r, 40));

    ctrl.abort();
    await done;

    expect(received).toEqual(['{"event":"stop","ts":"2025-01-01T00:00:01Z"}']);
  });

  it('caps the replayed backlog to the last N with `last`, then follows new lines (RE-4)', async () => {
    const ef = eventsPath(workerDir, 'sid-readev');
    appendEvent(ef, { event: 'session_start', ts: 'T0' });
    appendEvent(ef, { event: 'user_prompt_submit', ts: 'T1' });
    appendEvent(ef, { event: 'stop', ts: 'T2' });

    const received: string[] = [];
    const ctrl = new AbortController();
    const done = followEvents(
      makeCtx(workerDir),
      'sid-readev',
      { pollMs: 10, last: 2 },
      (line) => received.push(line),
      ctrl.signal,
    );
    await new Promise((r) => setTimeout(r, 40));
    appendEvent(ef, { event: 'session_end', ts: 'T3' });
    await new Promise((r) => setTimeout(r, 40));
    ctrl.abort();
    await done;

    // Backlog tailed to the last 2 (session_start skipped), then the new line.
    expect(received).toEqual([
      '{"event":"user_prompt_submit","ts":"T1"}',
      '{"event":"stop","ts":"T2"}',
      '{"event":"session_end","ts":"T3"}',
    ]);
  });

  it('follows only NEW events with `last: 0` (no backlog replay) (RE-4)', async () => {
    const ef = eventsPath(workerDir, 'sid-readev');
    appendEvent(ef, { event: 'session_start', ts: 'T0' });
    appendEvent(ef, { event: 'stop', ts: 'T1' });

    const received: string[] = [];
    const ctrl = new AbortController();
    const done = followEvents(
      makeCtx(workerDir),
      'sid-readev',
      { pollMs: 10, last: 0 },
      (line) => received.push(line),
      ctrl.signal,
    );
    await new Promise((r) => setTimeout(r, 40));
    appendEvent(ef, { event: 'session_end', ts: 'T2' });
    await new Promise((r) => setTimeout(r, 40));
    ctrl.abort();
    await done;

    expect(received).toEqual(['{"event":"session_end","ts":"T2"}']);
  });
});
