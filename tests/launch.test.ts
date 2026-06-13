import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdLaunch, shellQuote } from '../src/commands/launch.js';
import { grantConsent } from '../src/core/consent.js';
import { appendEvent } from '../src/core/event-log.js';
import { eventsPath, shimPath } from '../src/core/paths.js';
import type { Tmux } from '../src/core/tmux.js';
import { readMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface NewSessionCall {
  name: string;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
}

interface FakeTmuxState {
  hasSession: boolean;
  newSession: NewSessionCall[];
  respawnPane: NewSessionCall[];
}

/**
 * A fake tmux. `onNewSession` lets a test simulate the worker emitting its
 * session_start event the moment the session is created.
 */
function fakeTmux(state: FakeTmuxState, onNewSession?: () => void): Tmux {
  return {
    async hasSession() {
      return state.hasSession;
    },
    async killSession() {},
    async capturePane() {
      return '';
    },
    async capturePaneFull() {
      return '';
    },
    async sendText() {},
    async sendEnter() {},
    async sendKey() {},
    async newSession(name, cwd, env, argv) {
      state.newSession.push({ name, cwd, env, argv });
      onNewSession?.();
    },
    async respawnPane(name, cwd, env, argv) {
      state.respawnPane.push({ name, cwd, env, argv });
      onNewSession?.();
    },
  };
}

function makeCtx(workerDir: string, home: string, tmux: Tmux): CommandContext {
  return { workerDir, home, tmux, driver: getDriver('claude') };
}

function freshState(): FakeTmuxState {
  return { hasSession: false, newSession: [], respawnPane: [] };
}

const FAST = { trustTimeoutMs: 50, startTimeoutMs: 2000, pollMs: 10 };

describe('shellQuote', () => {
  it('leaves simple tokens unquoted', () => {
    expect(shellQuote('worker1')).toBe('worker1');
    expect(shellQuote('/tmp/path-to_thing.js')).toBe('/tmp/path-to_thing.js');
  });

  it('single-quotes tokens with whitespace or special chars', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('a;b')).toBe("'a;b'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('quotes the empty string', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('cmdLaunch', () => {
  let workerDir: string;
  let home: string;
  let cwd: string;
  let rawCwd: string;

  beforeEach(() => {
    // A non-default worker dir so ensureBackCompatSymlink is a no-op.
    workerDir = tmpDir('csd-launch-wd-');
    home = tmpDir('csd-launch-home-');
    rawCwd = tmpDir('csd-launch-cwd-');
    // The launch command resolves cwd to its realpath; compare against that.
    cwd = realpathSync(rawCwd);
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
    rmSync(home, { recursive: true });
    rmSync(rawCwd, { recursive: true });
  });

  const baseOpts = () => ({
    pluginDir: '/plugins/superpowers',
    csdEntry: '/dist/csd.cjs',
    csdPath: '/usr/local/bin/csd',
  });

  it('errors when cwd does not exist', async () => {
    grantConsent(home);
    const ctx = makeCtx(workerDir, home, fakeTmux(freshState()));
    const result = await cmdLaunch(
      ctx,
      { tmuxName: 'w1', cwd: '/no/such/dir', extraArgs: [], harness: 'claude' },
      { ...baseOpts(), ...FAST },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cwd '/no/such/dir' does not exist");
  });

  it('errors when consent has not been granted', async () => {
    const ctx = makeCtx(workerDir, home, fakeTmux(freshState()));
    const result = await cmdLaunch(
      ctx,
      { tmuxName: 'w1', cwd, extraArgs: [], harness: 'claude' },
      { ...baseOpts(), ...FAST },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('requires one-time consent');
    expect(result.stderr).toContain('/usr/local/bin/csd grant-consent');
  });

  it('errors when a tmux session with that name already exists', async () => {
    grantConsent(home);
    const state = freshState();
    state.hasSession = true;
    const ctx = makeCtx(workerDir, home, fakeTmux(state));
    const result = await cmdLaunch(
      ctx,
      { tmuxName: 'w1', cwd, extraArgs: [], harness: 'claude' },
      { ...baseOpts(), ...FAST },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tmux session 'w1' already exists");
    expect(state.newSession).toHaveLength(0);
  });

  it('launches: starts the session, awaits proof-of-life, writes meta+shim, prints panel', async () => {
    grantConsent(home);
    const state = freshState();
    let capturedSid: string | undefined;
    // The fake worker emits session_start as soon as the session is created.
    // The launch command writes the events file path from the sid it generated,
    // so we read it back from the meta after the fact; instead, emit on the
    // single events file the command is polling by deriving it lazily.
    const ctx = makeCtx(
      workerDir,
      home,
      fakeTmux(state, () => {
        // The argv carries --session-id <sid>; recover it to write the event.
        const argv = state.newSession.at(-1)?.argv ?? [];
        const i = argv.indexOf('--session-id');
        capturedSid = argv[i + 1] as string;
        appendEvent(eventsPath(workerDir, capturedSid), {
          event: 'session_start',
          ts: '2025-01-01T00:00:00Z',
        });
      }),
    );
    const result = await cmdLaunch(
      ctx,
      {
        tmuxName: 'w1',
        cwd,
        extraArgs: ['--model', 'opus'],
        harness: 'claude',
      },
      { ...baseOpts(), ...FAST },
    );

    expect(result.code).toBe(0);
    expect(capturedSid).toBeDefined();
    const sid = capturedSid as string;

    // stdout = the shim path.
    expect(result.stdout).toBe(shimPath(workerDir, 'w1'));

    // Panel on stderr with the expected fields.
    expect(result.stderr).toContain('Worker launched.');
    expect(result.stderr).toContain('tmux:       w1');
    expect(result.stderr).toContain(`session_id: ${sid}`);
    expect(result.stderr).toContain(`cwd:        ${cwd}`);
    expect(result.stderr).toContain(eventsPath(workerDir, sid));
    expect(result.stderr).toContain('reproduce: /usr/local/bin/csd launch');

    // newSession was called with the scrubbed env and the claude argv.
    expect(state.newSession).toHaveLength(1);
    const call = state.newSession[0]!;
    expect(call.name).toBe('w1');
    expect(call.cwd).toBe(cwd);
    expect(call.env.CLAUDE_CODE_SSE_PORT).toBe('');
    expect(call.argv).toContain('--session-id');
    expect(call.argv).toContain(sid);
    expect(call.argv).toContain('--plugin-dir');
    expect(call.argv).toContain('/plugins/superpowers');
    // Extra args are appended after the driver argv.
    expect(call.argv.slice(-2)).toEqual(['--model', 'opus']);

    // Meta written with all fields including harness.
    const meta = readMeta(workerDir, sid);
    expect(meta).toMatchObject({
      tmux_name: 'w1',
      session_id: sid,
      cwd,
      harness: 'claude',
    });
    expect(typeof meta?.started_at).toBe('string');
    expect(meta?.invocation).toEqual(['w1', cwd, '--', '--model', 'opus']);

    // Shim file exists and is executable.
    const mode = statSync(shimPath(workerDir, 'w1')).mode;
    expect(mode & 0o100).toBeTruthy();
  });

  it('fails and tears down when proof-of-life never arrives', async () => {
    grantConsent(home);
    const state = freshState();
    // newSession succeeds but no session_start is ever emitted.
    const ctx = makeCtx(workerDir, home, fakeTmux(state));
    const result = await cmdLaunch(
      ctx,
      { tmuxName: 'w1', cwd, extraArgs: [], harness: 'claude' },
      { ...baseOpts(), trustTimeoutMs: 20, startTimeoutMs: 40, pollMs: 10 },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: Worker session failed to start within 30 seconds',
    );
    // The session was started, then torn down: no meta remains for its sid.
    expect(state.newSession).toHaveLength(1);
    const argv = state.newSession[0]!.argv;
    const sid = argv[argv.indexOf('--session-id') + 1] as string;
    expect(readMeta(workerDir, sid)).toBeNull();
  });

  it('omits the -- separator in invocation when there are no extra args', async () => {
    grantConsent(home);
    const state = freshState();
    const ctx = makeCtx(
      workerDir,
      home,
      fakeTmux(state, () => {
        const argv = state.newSession.at(-1)?.argv ?? [];
        const sid = argv[argv.indexOf('--session-id') + 1] as string;
        appendEvent(eventsPath(workerDir, sid), {
          event: 'session_start',
          ts: '2025-01-01T00:00:00Z',
        });
      }),
    );
    await cmdLaunch(
      ctx,
      { tmuxName: 'w1', cwd, extraArgs: [], harness: 'claude' },
      { ...baseOpts(), ...FAST },
    );
    const argv = state.newSession[0]!.argv;
    const sid = argv[argv.indexOf('--session-id') + 1] as string;
    const meta = readMeta(workerDir, sid);
    expect(meta?.invocation).toEqual(['w1', cwd]);
  });
});
