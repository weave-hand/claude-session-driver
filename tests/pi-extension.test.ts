import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEndEvent,
  ExtensionContext,
  InputEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEvents } from '../src/core/event-log.js';
import { eventsPath, metaPath } from '../src/core/paths.js';
import { readMeta } from '../src/core/worker-store.js';
import csdPiExtension from '../src/pi-extension/index.js';

const SID = 'pi-sid-1';
const TMUX = 'pi-worker';
const CWD = '/proj';
const TRANSCRIPT = '/home/op/.pi/agent/sessions/--proj--/ts_pi-sid-1.jsonl';

/**
 * Captures the handlers an extension registers via `pi.on(name, fn)`. The
 * extension never throws (best-effort recording), so a fake is enough to drive
 * each handler and assert what it appended.
 */
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler>();
  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }
  fire(event: string, payload: unknown, ctx: ExtensionContext): unknown {
    const handler = this.handlers.get(event);
    if (handler === undefined) {
      throw new Error(`no handler registered for ${event}`);
    }
    return handler(payload, ctx);
  }
}

function fakeCtx(opts: {
  sid?: string;
  cwd?: string;
  sessionFile?: string | undefined;
}): ExtensionContext {
  const sid = opts.sid ?? SID;
  const cwd = opts.cwd ?? CWD;
  const sessionFile = 'sessionFile' in opts ? opts.sessionFile : TRANSCRIPT;
  // Only the fields the extension reads are populated; the rest of
  // ExtensionContext is irrelevant to the handlers under test.
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sid,
      getSessionFile: () => sessionFile,
      getCwd: () => cwd,
    },
  } as unknown as ExtensionContext;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-pi-ext-'));
}

let savedWorkerDir: string | undefined;
let savedTmuxName: string | undefined;

beforeEach(() => {
  savedWorkerDir = process.env.CSD_WORKER_DIR;
  savedTmuxName = process.env.CSD_TMUX_NAME;
});

afterEach(() => {
  if (savedWorkerDir === undefined) delete process.env.CSD_WORKER_DIR;
  else process.env.CSD_WORKER_DIR = savedWorkerDir;
  if (savedTmuxName === undefined) delete process.env.CSD_TMUX_NAME;
  else process.env.CSD_TMUX_NAME = savedTmuxName;
});

function register(dir: string, tmux: string = TMUX): FakePi {
  process.env.CSD_WORKER_DIR = dir;
  process.env.CSD_TMUX_NAME = tmux;
  const pi = new FakePi();
  csdPiExtension(pi as never);
  return pi;
}

const SESSION_START: SessionStartEvent = {
  type: 'session_start',
  reason: 'startup',
};
const INPUT_INTERACTIVE: InputEvent = {
  type: 'input',
  text: 'do the thing',
  source: 'interactive',
};
const TOOL_CALL: ToolCallEvent = {
  type: 'tool_call',
  toolCallId: 'tc1',
  toolName: 'bash',
  input: { command: 'ls' },
} as ToolCallEvent;
const TOOL_RESULT: ToolResultEvent = {
  type: 'tool_result',
  toolCallId: 'tc1',
  toolName: 'bash',
  input: { command: 'ls' },
  content: [],
  isError: false,
  details: undefined,
} as ToolResultEvent;
const AGENT_END: AgentEndEvent = { type: 'agent_end', messages: [] };
const SHUTDOWN_QUIT: SessionShutdownEvent = {
  type: 'session_shutdown',
  reason: 'quit',
};

describe('csd pi extension — handler registration', () => {
  it('registers all six lifecycle handlers', () => {
    const dir = tmpDir();
    const pi = register(dir);
    for (const name of [
      'session_start',
      'input',
      'tool_call',
      'tool_result',
      'agent_end',
      'session_shutdown',
    ]) {
      expect(pi.handlers.has(name)).toBe(true);
    }
  });
});

describe('csd pi extension — event mapping', () => {
  it('session_start → session_start WorkerEvent with cwd', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire('session_start', SESSION_START, fakeCtx({}));
    const events = readEvents(eventsPath(dir, SID));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'session_start', cwd: CWD });
    expect(typeof (events[0] as { ts: string }).ts).toBe('string');
  });

  it('interactive input → user_prompt_submit', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire('input', INPUT_INTERACTIVE, fakeCtx({}));
    const events = readEvents(eventsPath(dir, SID));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'user_prompt_submit' });
  });

  it('tool_call → pre_tool_use with tool + tool_input', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire('tool_call', TOOL_CALL, fakeCtx({}));
    const events = readEvents(eventsPath(dir, SID));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'pre_tool_use',
      tool: 'bash',
      tool_input: { command: 'ls' },
    });
  });

  it('tool_result → post_tool_use with tool (no tool_input)', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire('tool_result', TOOL_RESULT, fakeCtx({}));
    const events = readEvents(eventsPath(dir, SID));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'post_tool_use', tool: 'bash' });
    expect(events[0]).not.toHaveProperty('tool_input');
  });

  it('agent_end → stop', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire('agent_end', AGENT_END, fakeCtx({}));
    const events = readEvents(eventsPath(dir, SID));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'stop' });
  });

  it('session_shutdown with reason=quit → session_end', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire('session_shutdown', SHUTDOWN_QUIT, fakeCtx({}));
    const events = readEvents(eventsPath(dir, SID));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'session_end' });
  });
});

describe('csd pi extension — filtering / gating', () => {
  it('skips non-interactive input (rpc/extension source)', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire(
      'input',
      { type: 'input', text: 'x', source: 'rpc' } as InputEvent,
      fakeCtx({}),
    );
    pi.fire(
      'input',
      { type: 'input', text: 'x', source: 'extension' } as InputEvent,
      fakeCtx({}),
    );
    expect(readEvents(eventsPath(dir, SID))).toEqual([]);
  });

  it('skips session_shutdown when reason is not quit (reload/new/resume/fork)', () => {
    const dir = tmpDir();
    const pi = register(dir);
    for (const reason of ['reload', 'new', 'resume', 'fork'] as const) {
      pi.fire(
        'session_shutdown',
        { type: 'session_shutdown', reason } as SessionShutdownEvent,
        fakeCtx({}),
      );
    }
    expect(readEvents(eventsPath(dir, SID))).toEqual([]);
  });
});

describe('csd pi extension — meta self-registration', () => {
  it('self-registers <sid>.meta on the first event with harness/tmux_name/cwd/transcript_path', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire('session_start', SESSION_START, fakeCtx({}));
    expect(readMeta(dir, SID)).toEqual({
      tmux_name: TMUX,
      session_id: SID,
      cwd: CWD,
      harness: 'pi',
      transcript_path: TRANSCRIPT,
    });
  });

  it('omits transcript_path when getSessionFile() is undefined', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire(
      'session_start',
      SESSION_START,
      fakeCtx({ sessionFile: undefined }),
    );
    const meta = readMeta(dir, SID);
    expect(meta).not.toBeNull();
    expect(meta).not.toHaveProperty('transcript_path');
    expect(meta).toMatchObject({
      tmux_name: TMUX,
      session_id: SID,
      cwd: CWD,
      harness: 'pi',
    });
  });

  it('does not overwrite the meta on a later event', () => {
    const dir = tmpDir();
    const pi = register(dir);
    // First event self-registers with the original transcript.
    pi.fire('session_start', SESSION_START, fakeCtx({}));
    // Second event arrives with a DIFFERENT session file; meta must not change.
    pi.fire(
      'tool_call',
      TOOL_CALL,
      fakeCtx({ sessionFile: '/somewhere/else.jsonl' }),
    );
    expect(readMeta(dir, SID)?.transcript_path).toBe(TRANSCRIPT);
    // Both events still recorded.
    const events = readEvents(eventsPath(dir, SID));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'session_start' });
    expect(events[1]).toMatchObject({ event: 'pre_tool_use' });
  });

  it('a skipped event (non-interactive input) does not self-register the meta', () => {
    const dir = tmpDir();
    const pi = register(dir);
    pi.fire(
      'input',
      { type: 'input', text: 'x', source: 'rpc' } as InputEvent,
      fakeCtx({}),
    );
    expect(readMeta(dir, SID)).toBeNull();
  });
});

describe('csd pi extension — env contract', () => {
  it('no-ops gracefully when CSD_WORKER_DIR is unset', () => {
    delete process.env.CSD_WORKER_DIR;
    process.env.CSD_TMUX_NAME = TMUX;
    const pi = new FakePi();
    csdPiExtension(pi as never);
    // Firing must not throw and must not write anywhere we can observe.
    expect(() =>
      pi.fire('session_start', SESSION_START, fakeCtx({})),
    ).not.toThrow();
  });

  it('never throws out of a handler even on malformed event payloads', () => {
    const dir = tmpDir();
    const pi = register(dir);
    // A payload missing the fields the mapper expects must not crash pi.
    expect(() => pi.fire('tool_call', {}, fakeCtx({}))).not.toThrow();
    expect(() =>
      pi.fire('input', { type: 'input' }, fakeCtx({})),
    ).not.toThrow();
  });

  it('uses CSD_TMUX_NAME for the meta tmux_name', () => {
    const dir = tmpDir();
    const pi = register(dir, 'other-name');
    pi.fire('session_start', SESSION_START, fakeCtx({}));
    expect(readMeta(dir, SID)?.tmux_name).toBe('other-name');
  });
});

describe('csd pi extension — does not clobber an existing meta written at launch', () => {
  it('appends without rewriting a meta that already exists', () => {
    const dir = tmpDir();
    // Simulate a meta pre-written by some other path.
    writeFileSync(
      metaPath(dir, SID),
      JSON.stringify({
        tmux_name: 'pre-existing',
        session_id: SID,
        cwd: '/elsewhere',
        harness: 'pi',
      }),
    );
    const pi = register(dir);
    pi.fire('session_start', SESSION_START, fakeCtx({}));
    expect(readMeta(dir, SID)).toMatchObject({ tmux_name: 'pre-existing' });
    expect(readEvents(eventsPath(dir, SID))).toHaveLength(1);
  });
});
