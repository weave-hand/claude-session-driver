import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { resolveWorker } from '../src/commands/context.js';
import { appendEvent } from '../src/core/event-log.js';
import { eventsPath } from '../src/core/paths.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-resolve-'));
}

const BASE_META = {
  tmux_name: 'my-worker',
  session_id: 'sid-resolve',
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

describe('resolveWorker', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
    writeMeta(workerDir, BASE_META);
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('resolves a known session id to sid + meta', () => {
    const r = resolveWorker(makeCtx(workerDir), 'sid-resolve');
    expect('code' in r).toBe(false);
    if ('code' in r) throw new Error('unexpected error result');
    expect(r.sid).toBe('sid-resolve');
    expect(r.meta.tmux_name).toBe('my-worker');
  });

  it('resolves a tmux_name alias to sid + meta', () => {
    const r = resolveWorker(makeCtx(workerDir), 'my-worker');
    if ('code' in r) throw new Error('unexpected error result');
    expect(r.sid).toBe('sid-resolve');
  });

  it('returns a code-1 error result for an unknown worker', () => {
    const r = resolveWorker(makeCtx(workerDir), 'ghost');
    expect('code' in r).toBe(true);
    if (!('code' in r)) throw new Error('expected error result');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('ghost');
  });

  it('returns a code-1 error result when meta is missing but events exist', () => {
    const noMetaDir = tmpDir();
    // Create only an events file (resolveSession will accept the sid) with no meta.
    appendEvent(eventsPath(noMetaDir, 'sid-no-meta'), {
      event: 'stop',
      ts: new Date().toISOString(),
    });
    const r = resolveWorker(makeCtx(noMetaDir), 'sid-no-meta');
    if (!('code' in r)) throw new Error('expected error result');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no meta');
    rmSync(noMetaDir, { recursive: true });
  });
});
