import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dumpConverseDiag } from '../src/core/diagnostics.js';
import { makeTmux } from '../src/core/tmux.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-diag-'));
}

const NOW = '2026-06-13T12:00:00Z';

/** A stub ps runner so the test doesn't depend on the real process table. */
function psRunner(stdout: string) {
  return vi.fn().mockResolvedValue({ stdout, stderr: '', code: 0 });
}

describe('dumpConverseDiag', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it('writes all sections with known content (happy path)', async () => {
    const logFile = join(dir, 'log.jsonl');
    const eventFile = join(dir, 'events.jsonl');
    writeFileSync(logFile, 'LOGLINE-A\nLOGLINE-B\n');
    writeFileSync(eventFile, 'EVENTLINE-A\nEVENTLINE-B\n');
    const dest = join(dir, 'sub', 'diag.txt');

    const tmux = makeTmux(async (_cmd, args) => {
      if (args[0] === 'has-session') {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (args[0] === 'capture-pane') {
        return { stdout: 'PANE-CONTENT-LINE\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const ok = await dumpConverseDiag({
      sid: 'sid-1',
      worker: 'my-worker',
      tmuxName: 'tmux-name-1',
      logFile,
      eventFile,
      timeout: 90,
      dest,
      reason: 'converse_timeout',
      tmux,
      now: () => NOW,
      run: psRunner('PS-TREE-OUTPUT\n'),
    });

    expect(ok).toBe(true);
    const out = readFileSync(dest, 'utf8');
    // header + metadata
    expect(out).toContain(`=== csd converse diagnostic (${NOW}) ===`);
    expect(out).toContain('reason=converse_timeout');
    expect(out).toContain(
      'session_id=sid-1 worker=my-worker tmux_name=tmux-name-1 timeout=90s',
    );
    expect(out).toContain(`log_file=${logFile}`);
    expect(out).toContain(`event_file=${eventFile}`);
    // section headers
    expect(out).toContain(
      '--- ps -eHo pid,ppid,stat,etime,comm (last 100 lines) ---',
    );
    expect(out).toContain('PS-TREE-OUTPUT');
    expect(out).toContain(
      '--- tmux capture-pane -t tmux-name-1 (full scrollback, tail 200) ---',
    );
    expect(out).toContain('PANE-CONTENT-LINE');
    expect(out).toContain(
      `--- claude session JSONL tail (last 30 lines from ${logFile}) ---`,
    );
    expect(out).toContain('LOGLINE-A');
    expect(out).toContain('LOGLINE-B');
    expect(out).toContain(
      `--- csd events JSONL tail (last 20 lines from ${eventFile}) ---`,
    );
    expect(out).toContain('EVENTLINE-A');
    expect(out).toContain('=== end csd diagnostic ===');
  });

  it('notes a missing tmux session, missing log, and missing event file', async () => {
    const logFile = join(dir, 'nope-log.jsonl');
    const eventFile = join(dir, 'nope-events.jsonl');
    const dest = join(dir, 'diag.txt');

    const tmux = makeTmux(async (_cmd, args) => {
      if (args[0] === 'has-session') {
        return { stdout: '', stderr: '', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const ok = await dumpConverseDiag({
      sid: 'sid-2',
      worker: 'gone-worker',
      tmuxName: 'absent-tmux',
      logFile,
      eventFile,
      timeout: 60,
      dest,
      reason: 'converse_timeout',
      tmux,
      now: () => NOW,
      run: psRunner(''),
    });

    expect(ok).toBe(true);
    const out = readFileSync(dest, 'utf8');
    expect(out).toContain("(tmux session 'absent-tmux' not present)");
    expect(out).toContain('(log file not present)');
    expect(out).toContain('(event file not present)');
  });

  it('returns false when the destination directory cannot be created', async () => {
    // Make a regular file, then try to write a dest UNDER it -> mkdir ENOTDIR.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const dest = join(blocker, 'sub', 'diag.txt');

    const tmux = makeTmux(async () => ({ stdout: '', stderr: '', code: 0 }));

    const ok = await dumpConverseDiag({
      sid: 'sid-3',
      worker: 'w',
      tmuxName: 't',
      logFile: join(dir, 'log'),
      eventFile: join(dir, 'ev'),
      timeout: 10,
      dest,
      reason: 'converse_timeout',
      tmux,
      now: () => NOW,
      run: psRunner(''),
    });

    expect(ok).toBe(false);
  });

  it('still succeeds (best-effort) when the ps runner fails', async () => {
    const dest = join(dir, 'diag.txt');
    const tmux = makeTmux(async () => ({ stdout: '', stderr: '', code: 0 }));
    const failingRun = vi.fn().mockRejectedValue(new Error('no ps here'));

    const ok = await dumpConverseDiag({
      sid: 'sid-4',
      worker: 'w',
      tmuxName: 't',
      logFile: join(dir, 'log'),
      eventFile: join(dir, 'ev'),
      timeout: 10,
      dest,
      reason: 'converse_timeout',
      tmux,
      now: () => NOW,
      run: failingRun,
    });

    expect(ok).toBe(true);
    const out = readFileSync(dest, 'utf8');
    expect(out).toContain('=== end csd diagnostic ===');
  });
});
