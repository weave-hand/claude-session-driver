import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdPrune } from '../src/commands/prune.js';
import { metaPath } from '../src/core/paths.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

/** A session is alive iff its name is in `alive` (decided by the has-session -t arg). */
function makeCtx(dir: string, alive: Set<string>): CommandContext {
  const tmux = makeTmux(async (_cmd, args) => {
    if (args[0] === 'has-session') {
      const name = args[args.indexOf('-t') + 1] ?? '';
      return { stdout: '', stderr: '', code: alive.has(name) ? 0 : 1 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  return { workerDir: dir, home: dir, tmux, driver: getDriver('claude') };
}

describe('cmdPrune', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'csd-prune-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  const mk = (name: string, sid: string) =>
    writeMeta(dir, {
      tmux_name: name,
      session_id: sid,
      cwd: '/w',
      harness: 'claude',
    });

  it('removes gone workers, keeps live ones, and reports the count', async () => {
    mk('alive1', 'sid-a');
    mk('dead1', 'sid-d1');
    mk('dead2', 'sid-d2');

    const result = await cmdPrune(makeCtx(dir, new Set(['alive1'])));

    expect(result.code).toBe(0);
    // live worker untouched; gone workers' state removed
    expect(existsSync(metaPath(dir, 'sid-a'))).toBe(true);
    expect(existsSync(metaPath(dir, 'sid-d1'))).toBe(false);
    expect(existsSync(metaPath(dir, 'sid-d2'))).toBe(false);
    expect(result.stdout).toContain('2');
    expect(result.stdout).toContain('dead1');
    expect(result.stdout).toContain('dead2');
    expect(result.stdout).not.toContain('alive1');
  });

  it('reports nothing to prune when every worker is live', async () => {
    mk('alive1', 'sid-a');
    const result = await cmdPrune(makeCtx(dir, new Set(['alive1'])));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('No gone workers to prune');
    expect(result.stdout).toBeUndefined();
  });
});
