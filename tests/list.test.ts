import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdList } from '../src/commands/list.js';
import { appendEvent } from '../src/core/event-log.js';
import { eventsPath, shimPath } from '../src/core/paths.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-list-'));
}

/**
 * A fake tmux whose `has-session` answer is decided per session name: a session
 * is "alive" iff its name is in `aliveNames`. The session name is the `-t`
 * argument of the has-session call.
 */
function fakeTmux(aliveNames: Set<string>) {
  return makeTmux(async (_cmd, args) => {
    if (args[0] === 'has-session') {
      const name = args[args.indexOf('-t') + 1] ?? '';
      return { stdout: '', stderr: '', code: aliveNames.has(name) ? 0 : 1 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
}

function makeCtx(workerDir: string, aliveNames: Set<string>): CommandContext {
  return {
    workerDir,
    home: workerDir,
    tmux: fakeTmux(aliveNames),
    driver: getDriver('claude'),
  };
}

const HEADER = 'STATUS\tHARNESS\tTMUX\tSESSION_ID\tSHIM\tCWD';

describe('cmdList', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('reports no workers (code 0, stderr message)', async () => {
    const result = await cmdList(makeCtx(workerDir, new Set()), {});
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('No workers found');
    expect(result.stdout).toBeUndefined();
  });

  it('lists alive workers with status, hiding gone ones by default', async () => {
    writeMeta(workerDir, {
      tmux_name: 'alpha',
      session_id: 'sid-a',
      cwd: '/work/a',
      harness: 'claude',
    });
    writeMeta(workerDir, {
      tmux_name: 'beta',
      session_id: 'sid-b',
      cwd: '/work/b',
      harness: 'claude',
    });
    // alpha is idle (stop), beta is gone (no tmux session).
    appendEvent(eventsPath(workerDir, 'sid-a'), {
      event: 'stop',
      ts: '2025-01-01T00:00:00Z',
    });

    const ctx = makeCtx(workerDir, new Set(['alpha']));
    const result = await cmdList(ctx, {});
    expect(result.code).toBe(0);
    const lines = (result.stdout ?? '').split('\n');
    expect(lines[0]).toBe(HEADER);
    const rows = lines.slice(1);
    expect(rows).toContain(
      `idle\tclaude\talpha\tsid-a\t${shimPath(workerDir, 'alpha')}\t/work/a`,
    );
    // beta is gone -> hidden by default.
    expect(result.stdout).not.toContain('beta');
  });

  it('shows the harness in its own column for a mixed fleet', async () => {
    writeMeta(workerDir, {
      tmux_name: 'cx',
      session_id: 'sid-cx',
      cwd: '/work/cx',
      harness: 'codex',
    });
    appendEvent(eventsPath(workerDir, 'sid-cx'), {
      event: 'stop',
      ts: '2025-01-01T00:00:00Z',
    });
    const result = await cmdList(makeCtx(workerDir, new Set(['cx'])), {});
    expect(result.stdout).toContain(
      `idle\tcodex\tcx\tsid-cx\t${shimPath(workerDir, 'cx')}\t/work/cx`,
    );
  });

  it('shows gone workers with --all', async () => {
    writeMeta(workerDir, {
      tmux_name: 'beta',
      session_id: 'sid-b',
      cwd: '/work/b',
      harness: 'claude',
    });
    const ctx = makeCtx(workerDir, new Set());
    const result = await cmdList(ctx, { all: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `gone\tclaude\tbeta\tsid-b\t${shimPath(workerDir, 'beta')}\t/work/b`,
    );
  });

  it('filters by substring pattern on tmux_name', async () => {
    writeMeta(workerDir, {
      tmux_name: 'frontend-1',
      session_id: 'sid-f',
      cwd: '/work/f',
      harness: 'claude',
    });
    writeMeta(workerDir, {
      tmux_name: 'backend-1',
      session_id: 'sid-bk',
      cwd: '/work/bk',
      harness: 'claude',
    });
    appendEvent(eventsPath(workerDir, 'sid-f'), {
      event: 'stop',
      ts: '2025-01-01T00:00:00Z',
    });
    appendEvent(eventsPath(workerDir, 'sid-bk'), {
      event: 'stop',
      ts: '2025-01-01T00:00:00Z',
    });

    const ctx = makeCtx(workerDir, new Set(['frontend-1', 'backend-1']));
    const result = await cmdList(ctx, { pattern: 'front' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('frontend-1');
    expect(result.stdout).not.toContain('backend-1');
  });
});
