import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdEventsFile } from '../src/commands/events-file.js';
import { eventsPath } from '../src/core/paths.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-evf-'));
}

const BASE_META = {
  tmux_name: 'my-worker',
  session_id: 'abc-456',
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

describe('cmdEventsFile', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, BASE_META);
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('returns the correct events file path for a known session id', async () => {
    const result = await cmdEventsFile(makeCtx(workerDir), 'abc-456');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(eventsPath(workerDir, 'abc-456'));
  });

  it('returns the correct events file path when given a tmux_name alias', async () => {
    const result = await cmdEventsFile(makeCtx(workerDir), 'my-worker');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(eventsPath(workerDir, 'abc-456'));
  });

  it('returns code 1 for an unknown worker', async () => {
    const result = await cmdEventsFile(makeCtx(workerDir), 'ghost');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ghost');
  });
});
