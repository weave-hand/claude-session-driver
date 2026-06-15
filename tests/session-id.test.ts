import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdSessionId } from '../src/commands/session-id.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-sid-'));
}

const BASE_META = {
  tmux_name: 'my-worker',
  session_id: 'abc-123',
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

describe('cmdSessionId', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, BASE_META);
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('returns the session id for a known session id arg', async () => {
    const result = await cmdSessionId(makeCtx(workerDir), 'abc-123');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('abc-123');
  });

  it('returns the session id when given a tmux_name alias', async () => {
    const result = await cmdSessionId(makeCtx(workerDir), 'my-worker');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('abc-123');
  });

  it('returns code 1 for an unknown worker', async () => {
    const result = await cmdSessionId(makeCtx(workerDir), 'unknown-worker');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown-worker');
  });
});
