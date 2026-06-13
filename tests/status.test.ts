import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdStatus, computeStatus } from '../src/commands/status.js';
import { appendEvent } from '../src/core/event-log.js';
import { eventsPath } from '../src/core/paths.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-status-'));
}

const BASE_META = {
  tmux_name: 'test-worker',
  session_id: 'sid-status-test',
  cwd: '/home/user/project',
  harness: 'claude',
};

/** Make a fake tmux where has-session returns the given code. */
function fakeTmux(hasSessionResult: boolean) {
  return makeTmux(async (_cmd, args) => {
    if (args[0] === 'has-session') {
      return { stdout: '', stderr: '', code: hasSessionResult ? 0 : 1 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
}

describe('cmdStatus', () => {
  let workerDir: string;
  let ctx: CommandContext;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, BASE_META);
    ctx = {
      workerDir,
      home: workerDir,
      tmux: fakeTmux(true),
      driver: getDriver('claude'),
    };
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('returns code 1 for unknown worker', async () => {
    const result = await cmdStatus(ctx, 'no-such-worker');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no-such-worker');
  });

  it('returns gone when tmux session does not exist', async () => {
    ctx = { ...ctx, tmux: fakeTmux(false) };
    const result = await cmdStatus(ctx, 'sid-status-test');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('gone');
  });

  it('returns unknown when events file does not exist', async () => {
    const result = await cmdStatus(ctx, 'sid-status-test');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('unknown');
  });

  it('returns unknown when events file is empty', async () => {
    writeFileSync(eventsPath(workerDir, 'sid-status-test'), '');
    const result = await cmdStatus(ctx, 'sid-status-test');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('unknown');
  });

  it('returns idle for last event = stop', async () => {
    appendEvent(eventsPath(workerDir, 'sid-status-test'), {
      event: 'stop',
      ts: new Date().toISOString(),
    });
    const result = await cmdStatus(ctx, 'sid-status-test');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('idle');
  });

  it('returns working for last event = pre_tool_use', async () => {
    appendEvent(eventsPath(workerDir, 'sid-status-test'), {
      event: 'pre_tool_use',
      ts: new Date().toISOString(),
      tool: 'Bash',
      tool_input: {},
    });
    const result = await cmdStatus(ctx, 'sid-status-test');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('working');
  });

  it('returns terminated for last event = session_end', async () => {
    appendEvent(eventsPath(workerDir, 'sid-status-test'), {
      event: 'session_end',
      ts: new Date().toISOString(),
    });
    const result = await cmdStatus(ctx, 'sid-status-test');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('terminated');
  });

  it('also resolves by tmux_name alias', async () => {
    appendEvent(eventsPath(workerDir, 'sid-status-test'), {
      event: 'stop',
      ts: new Date().toISOString(),
    });
    const result = await cmdStatus(ctx, 'test-worker');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('idle');
  });
});

describe('computeStatus', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, BASE_META);
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('returns gone when tmux session does not exist', async () => {
    const ctx = {
      workerDir,
      home: workerDir,
      tmux: fakeTmux(false),
      driver: getDriver('claude'),
    };
    const status = await computeStatus(ctx, BASE_META);
    expect(status).toBe('gone');
  });

  it('returns idle for session_start event', async () => {
    appendEvent(eventsPath(workerDir, 'sid-status-test'), {
      event: 'session_start',
      ts: new Date().toISOString(),
    });
    const ctx = {
      workerDir,
      home: workerDir,
      tmux: fakeTmux(true),
      driver: getDriver('claude'),
    };
    const status = await computeStatus(ctx, BASE_META);
    expect(status).toBe('idle');
  });
});
