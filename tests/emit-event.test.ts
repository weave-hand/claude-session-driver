import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../src/core/event-log.js';
import { eventsPath, metaPath } from '../src/core/paths.js';
import { runHook } from '../src/hooks/emit-event.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-hook-'));
}

const SID = 'S';

// A worker session is "managed" iff a <sid>.meta file exists in the worker dir.
function makeWorker(dir: string, sid = SID): void {
  writeFileSync(
    metaPath(dir, sid),
    JSON.stringify({ tmux_name: 'test', session_id: sid }),
  );
}

// Deterministic clock so appended events have a fixed ts.
const fixedNow = () => 'T';

function run(stdin: string, dir: string) {
  return runHook({ stdin, workerDir: dir, now: fixedNow });
}

describe('runHook — SessionStart', () => {
  it('appends session_start with cwd for a managed worker', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'SessionStart',
      cwd: '/x',
    });
    const result = run(stdin, dir);
    expect(result.stdout).toBe('');
    expect(result.appended).toEqual({
      event: 'session_start',
      ts: 'T',
      cwd: '/x',
    });
    expect(readEvents(eventsPath(dir, SID))).toEqual([
      { event: 'session_start', ts: 'T', cwd: '/x' },
    ]);
  });

  it('omits cwd when cwd is missing', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'SessionStart',
    });
    const result = run(stdin, dir);
    expect(result.appended).toEqual({ event: 'session_start', ts: 'T' });
    expect(result.appended).not.toHaveProperty('cwd');
  });

  it('omits cwd when cwd is empty', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'SessionStart',
      cwd: '',
    });
    const result = run(stdin, dir);
    expect(result.appended).toEqual({ event: 'session_start', ts: 'T' });
  });

  it('does nothing when there is no <sid>.meta', () => {
    const dir = tmpDir();
    // no makeWorker
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'SessionStart',
      cwd: '/x',
    });
    const result = run(stdin, dir);
    expect(result).toEqual({ stdout: '' });
    expect(result.appended).toBeUndefined();
    expect(readEvents(eventsPath(dir, SID))).toEqual([]);
  });
});

describe('runHook — tool use', () => {
  it('records tool and tool_input for PreToolUse', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { cmd: 'ls' },
    });
    const result = run(stdin, dir);
    expect(result.stdout).toBe('');
    expect(result.appended).toEqual({
      event: 'pre_tool_use',
      ts: 'T',
      tool: 'Bash',
      tool_input: { cmd: 'ls' },
    });
    expect(readEvents(eventsPath(dir, SID))).toEqual([
      {
        event: 'pre_tool_use',
        ts: 'T',
        tool: 'Bash',
        tool_input: { cmd: 'ls' },
      },
    ]);
  });

  it('defaults tool to "" and tool_input to {} when missing', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'PreToolUse',
    });
    const result = run(stdin, dir);
    expect(result.appended).toEqual({
      event: 'pre_tool_use',
      ts: 'T',
      tool: '',
      tool_input: {},
    });
  });

  it('coerces non-object tool_input to {} for PreToolUse', () => {
    const dir = tmpDir();
    makeWorker(dir);
    // tool_input is a string — not a valid object; should be coerced to {}
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: 'oops',
    });
    const result = run(stdin, dir);
    expect(result.appended).toEqual({
      event: 'pre_tool_use',
      ts: 'T',
      tool: 'Bash',
      tool_input: {},
    });
    // Also verify null is coerced to {}
    const stdin2 = JSON.stringify({
      session_id: SID,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: null,
    });
    const result2 = run(stdin2, dir);
    expect(result2.appended).toEqual({
      event: 'pre_tool_use',
      ts: 'T',
      tool: 'Bash',
      tool_input: {},
    });
  });

  it('records only tool for PostToolUse (no tool_input)', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { cmd: 'ls' },
    });
    const result = run(stdin, dir);
    expect(result.stdout).toBe('');
    expect(result.appended).toEqual({
      event: 'post_tool_use',
      ts: 'T',
      tool: 'Bash',
    });
    expect(result.appended).not.toHaveProperty('tool_input');
  });
});

describe('runHook — Stop', () => {
  it('approves on stdout and appends a stop event', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({ session_id: SID, hook_event_name: 'Stop' });
    const result = run(stdin, dir);
    expect(result.stdout).toBe('{"decision":"approve"}');
    expect(result.appended).toEqual({ event: 'stop', ts: 'T' });
    expect(readEvents(eventsPath(dir, SID))).toEqual([
      { event: 'stop', ts: 'T' },
    ]);
  });
});

describe('runHook — bare events', () => {
  it('appends user_prompt_submit with empty stdout', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'UserPromptSubmit',
    });
    const result = run(stdin, dir);
    expect(result.stdout).toBe('');
    expect(result.appended).toEqual({ event: 'user_prompt_submit', ts: 'T' });
  });

  it('appends session_end with empty stdout', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'SessionEnd',
    });
    const result = run(stdin, dir);
    expect(result.stdout).toBe('');
    expect(result.appended).toEqual({ event: 'session_end', ts: 'T' });
  });
});

describe('runHook — no-op cases', () => {
  it('no-ops on empty stdin', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const result = run('', dir);
    expect(result).toEqual({ stdout: '' });
    expect(readEvents(eventsPath(dir, SID))).toEqual([]);
  });

  it('no-ops on garbage stdin', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const result = run('not json', dir);
    expect(result).toEqual({ stdout: '' });
    expect(readEvents(eventsPath(dir, SID))).toEqual([]);
  });

  it('no-ops on an unknown hook_event_name even with meta', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      session_id: SID,
      hook_event_name: 'Notification',
    });
    const result = run(stdin, dir);
    expect(result).toEqual({ stdout: '' });
    expect(readEvents(eventsPath(dir, SID))).toEqual([]);
  });

  it('no-ops when session_id is missing', () => {
    const dir = tmpDir();
    makeWorker(dir);
    const stdin = JSON.stringify({
      hook_event_name: 'SessionStart',
      cwd: '/x',
    });
    const result = run(stdin, dir);
    expect(result).toEqual({ stdout: '' });
  });
});
