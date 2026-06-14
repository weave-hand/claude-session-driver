import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdStop } from '../src/commands/stop.js';
import { appendEvent } from '../src/core/event-log.js';
import {
  eventsPath,
  metaPath,
  shimPath,
  workerHomePath,
} from '../src/core/paths.js';
import type { Tmux } from '../src/core/tmux.js';
import { writeMeta, writeShim } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-stop-'));
}

const SID = 'sid-stop';
const TMUX_NAME = 'stop-worker';

interface FakeTmuxCalls {
  sendText: Array<{ name: string; text: string }>;
  sendEnter: string[];
  killSession: string[];
}

/**
 * A fake tmux whose `hasSession` is supplied by a callback so a test can flip
 * the answer across calls (alive before quit, gone after kill).
 */
function fakeTmux(
  hasSessionFn: () => boolean,
  calls: FakeTmuxCalls,
  onSendEnter?: () => void,
): Tmux {
  return {
    async hasSession() {
      return hasSessionFn();
    },
    async killSession(name: string) {
      calls.killSession.push(name);
    },
    async capturePane() {
      return '';
    },
    async capturePaneFull() {
      return '';
    },
    async sendText(name: string, text: string) {
      calls.sendText.push({ name, text });
    },
    async sendEnter(name: string) {
      calls.sendEnter.push(name);
      onSendEnter?.();
    },
    async sendKey() {},
    async newSession() {},
    async respawnPane() {},
  };
}

function makeCtx(workerDir: string, tmux: Tmux): CommandContext {
  return {
    workerDir,
    home: workerDir,
    tmux,
    driver: getDriver('claude'),
  };
}

function seedWorker(workerDir: string): void {
  writeMeta(workerDir, {
    tmux_name: TMUX_NAME,
    session_id: SID,
    cwd: '/home/user/project',
    harness: 'claude',
  });
  appendEvent(eventsPath(workerDir, SID), {
    event: 'session_start',
    ts: '2025-01-01T00:00:00Z',
  });
  writeShim(workerDir, TMUX_NAME, '/path/to/csd.js');
}

function filesExist(workerDir: string): {
  meta: boolean;
  events: boolean;
  shim: boolean;
} {
  return {
    meta: existsSync(metaPath(workerDir, SID)),
    events: existsSync(eventsPath(workerDir, SID)),
    shim: existsSync(shimPath(workerDir, TMUX_NAME)),
  };
}

describe('cmdStop', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    seedWorker(workerDir);
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('returns code 1 for an unknown worker', async () => {
    const calls: FakeTmuxCalls = {
      sendText: [],
      sendEnter: [],
      killSession: [],
    };
    const ctx = makeCtx(
      workerDir,
      fakeTmux(() => true, calls),
    );
    const result = await cmdStop(ctx, 'ghost', {
      stopTimeout: 0.1,
      pollMs: 10,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ghost');
  });

  it('sends quit keys, waits for session_end, removes the worker', async () => {
    const ef = eventsPath(workerDir, SID);
    const calls: FakeTmuxCalls = {
      sendText: [],
      sendEnter: [],
      killSession: [],
    };
    // Session is alive until the quit keys are sent, then session_end arrives
    // and the session goes away (so no kill is needed).
    let alive = true;
    const tmux = fakeTmux(
      () => alive,
      calls,
      () => {
        appendEvent(ef, { event: 'session_end', ts: '2025-01-01T00:00:01Z' });
        alive = false;
      },
    );
    const ctx = makeCtx(workerDir, tmux);
    const result = await cmdStop(ctx, SID, {
      stopTimeout: 5,
      pollMs: 10,
      settleMs: 0,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Worker ${TMUX_NAME} (${SID}) stopped. Shim removed.`,
    );
    expect(calls.sendText).toEqual([
      { name: TMUX_NAME, text: getDriver('claude').quitKeys },
    ]);
    expect(calls.sendEnter).toEqual([TMUX_NAME]);
    // Session was gone after session_end; no kill needed.
    expect(calls.killSession).toHaveLength(0);
    expect(filesExist(workerDir)).toEqual({
      meta: false,
      events: false,
      shim: false,
    });
  });

  it('kills the session when it survives the quit-keys wait', async () => {
    const calls: FakeTmuxCalls = {
      sendText: [],
      sendEnter: [],
      killSession: [],
    };
    // Session never reports session_end and stays alive: stop must kill it.
    const tmux = fakeTmux(() => true, calls);
    const ctx = makeCtx(workerDir, tmux);
    const result = await cmdStop(ctx, SID, { stopTimeout: 0.1, pollMs: 10 });

    expect(result.code).toBe(0);
    expect(calls.sendText).toEqual([
      { name: TMUX_NAME, text: getDriver('claude').quitKeys },
    ]);
    expect(calls.killSession).toEqual([TMUX_NAME]);
    expect(filesExist(workerDir)).toEqual({
      meta: false,
      events: false,
      shim: false,
    });
  });

  it('skips quit/kill when the session is already gone', async () => {
    const calls: FakeTmuxCalls = {
      sendText: [],
      sendEnter: [],
      killSession: [],
    };
    const tmux = fakeTmux(() => false, calls);
    const ctx = makeCtx(workerDir, tmux);
    const result = await cmdStop(ctx, SID, { stopTimeout: 5, pollMs: 10 });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Worker ${TMUX_NAME} (${SID}) stopped. Shim removed.`,
    );
    expect(calls.sendText).toHaveLength(0);
    expect(calls.sendEnter).toHaveLength(0);
    expect(calls.killSession).toHaveLength(0);
    expect(filesExist(workerDir)).toEqual({
      meta: false,
      events: false,
      shim: false,
    });
  });

  it('removes the per-worker home (staged operator credentials) on stop', async () => {
    // A derive worker stages the operator's auth in a per-worker home.
    const home = workerHomePath(workerDir, TMUX_NAME);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), '{"token":"operator-secret"}');

    const calls: FakeTmuxCalls = {
      sendText: [],
      sendEnter: [],
      killSession: [],
    };
    const tmux = fakeTmux(() => false, calls);
    const ctx = makeCtx(workerDir, tmux);
    const result = await cmdStop(ctx, SID, { stopTimeout: 5, pollMs: 10 });

    expect(result.code).toBe(0);
    expect(existsSync(home)).toBe(false);
  });
});
