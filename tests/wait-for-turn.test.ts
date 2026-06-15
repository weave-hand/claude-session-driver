import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdWaitForTurn } from '../src/commands/wait-for-turn.js';
import { appendEvent } from '../src/core/event-log.js';
import { eventsPath } from '../src/core/paths.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-wft-'));
}

const SID = 'sid-wft';

function makeCtx(workerDir: string): CommandContext {
  return {
    workerDir,
    home: workerDir,
    tmux: makeTmux(async () => ({ stdout: '', stderr: '', code: 0 })),
    driver: getDriver('claude'),
  };
}

describe('cmdWaitForTurn', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, {
      tmux_name: 'wft-worker',
      session_id: SID,
      cwd: '/home/user/project',
      harness: 'claude',
    });
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('waits for the NEXT turn-end, ignoring a stale stop already in the file (BUG-1)', async () => {
    const ef = eventsPath(workerDir, SID);
    appendEvent(ef, { event: 'session_start', ts: '2025-01-01T00:00:00Z' });
    // A stop from a PREVIOUS turn is already on disk. A bare wait-for-turn must
    // not return it; it must block for the turn-end of the CURRENT turn.
    appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:01Z' });
    const p = cmdWaitForTurn(makeCtx(workerDir), SID, {
      timeout: 5,
      pollMs: 10,
    });
    setTimeout(() => {
      appendEvent(ef, {
        event: 'user_prompt_submit',
        ts: '2025-01-01T00:00:02Z',
      });
      appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:03Z' });
    }, 30);
    const result = await p;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"event":"stop","ts":"2025-01-01T00:00:03Z"}');
  });

  it('returns session_end as a matching turn end', async () => {
    const ef = eventsPath(workerDir, SID);
    appendEvent(ef, { event: 'session_start', ts: '2025-01-01T00:00:00Z' });
    const p = cmdWaitForTurn(makeCtx(workerDir), SID, {
      timeout: 5,
      pollMs: 10,
    });
    setTimeout(() => {
      appendEvent(ef, { event: 'session_end', ts: '2025-01-01T00:00:09Z' });
    }, 30);
    const result = await p;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      '{"event":"session_end","ts":"2025-01-01T00:00:09Z"}',
    );
  });

  it('returns the FIRST stop/session_end after afterLine', async () => {
    const ef = eventsPath(workerDir, SID);
    appendEvent(ef, { event: 'session_start', ts: '2025-01-01T00:00:00Z' });
    appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:01Z' });
    appendEvent(ef, {
      event: 'user_prompt_submit',
      ts: '2025-01-01T00:00:02Z',
    });
    appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:03Z' });
    // afterLine 2 => ignore the first two lines (incl. the stop at line 2),
    // find the next stop (line 4).
    const result = await cmdWaitForTurn(makeCtx(workerDir), SID, {
      timeout: 5,
      pollMs: 10,
      afterLine: 2,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"event":"stop","ts":"2025-01-01T00:00:03Z"}');
  });

  it('waits for a stop event appended after the call starts', async () => {
    const ef = eventsPath(workerDir, SID);
    appendEvent(ef, { event: 'session_start', ts: '2025-01-01T00:00:00Z' });
    const p = cmdWaitForTurn(makeCtx(workerDir), SID, {
      timeout: 5,
      pollMs: 10,
    });
    setTimeout(() => {
      appendEvent(ef, { event: 'stop', ts: '2025-01-01T00:00:01Z' });
    }, 30);
    const result = await p;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"event":"stop","ts":"2025-01-01T00:00:01Z"}');
  });

  it('times out with code 1 when no turn end appears', async () => {
    const ef = eventsPath(workerDir, SID);
    appendEvent(ef, { event: 'session_start', ts: '2025-01-01T00:00:00Z' });
    appendEvent(ef, {
      event: 'user_prompt_submit',
      ts: '2025-01-01T00:00:01Z',
    });
    const result = await cmdWaitForTurn(makeCtx(workerDir), SID, {
      timeout: 0.2,
      pollMs: 10,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'Timeout waiting for turn (stop or session_end) after 0.2s',
    );
  });

  it('times out waiting for the event file when it never appears', async () => {
    const result = await cmdWaitForTurn(makeCtx(workerDir), SID, {
      timeout: 0.2,
      pollMs: 10,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `Timeout waiting for event file: ${eventsPath(workerDir, SID)}`,
    );
  });

  it('returns code 1 for an unknown worker', async () => {
    const result = await cmdWaitForTurn(makeCtx(workerDir), 'ghost', {
      timeout: 0.2,
      pollMs: 10,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ghost');
  });
});
