import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdHandoff } from '../src/commands/handoff.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-handoff-'));
}

function makeCtx(workerDir: string): CommandContext {
  return {
    workerDir,
    home: workerDir,
    tmux: makeTmux(async () => ({ stdout: '', stderr: '', code: 0 })),
    driver: getDriver('claude'),
  };
}

describe('cmdHandoff', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, {
      tmux_name: 'cool-worker',
      session_id: 'sid-handoff',
      cwd: '/home/user/project',
      harness: 'claude',
    });
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('emits handoff instructions referencing the tmux name', async () => {
    const result = await cmdHandoff(makeCtx(workerDir), 'sid-handoff');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "The worker is running in tmux session 'cool-worker'.",
    );
    expect(result.stdout).toContain('tmux attach -t cool-worker');
    expect(result.stdout).toContain('Detach with Ctrl-B d');
  });

  it('keeps the literal $WORKER token in the resume note', async () => {
    const result = await cmdHandoff(makeCtx(workerDir), 'sid-handoff');
    expect(result.stdout).toContain('do not run $WORKER stop');
  });

  it('resolves by tmux_name alias too', async () => {
    const result = await cmdHandoff(makeCtx(workerDir), 'cool-worker');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('tmux attach -t cool-worker');
  });

  it('returns code 1 for an unknown worker', async () => {
    const result = await cmdHandoff(makeCtx(workerDir), 'ghost');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ghost');
  });
});
