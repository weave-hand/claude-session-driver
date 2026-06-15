import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { awaitPiReady } from '../src/commands/pi-launch.js';
import type { Tmux } from '../src/core/tmux.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-pi-launch-'));
}

interface FakeTmuxCalls {
  capturePane: string[];
}

/** A fake tmux whose pane text is computed per-capture by `paneText`. */
function fakeTmux(calls: FakeTmuxCalls, paneText: () => string): Tmux {
  return {
    async hasSession() {
      return true;
    },
    async killSession() {},
    async capturePane(name: string) {
      calls.capturePane.push(name);
      return paneText();
    },
    async capturePaneFull() {
      return paneText();
    },
    async sendText() {},
    async sendEnter() {},
    async sendKey() {},
    async newSession() {},
    async respawnPane() {},
  };
}

function makeCtx(workerDir: string, tmux: Tmux): CommandContext {
  return { workerDir, home: workerDir, tmux, driver: getDriver('pi') };
}

const TMUX_NAME = 'pi-worker';

describe('awaitPiReady', () => {
  let workerDir: string;

  beforeEach(() => {
    workerDir = tmpDir();
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
  });

  it('returns once the pi status-bar gauge appears', async () => {
    const calls: FakeTmuxCalls = { capturePane: [] };
    // Big timeout so the test only finishes fast if the gauge is seen.
    const ctx = makeCtx(
      workerDir,
      fakeTmux(calls, () => '0.0%/272k (auto)'),
    );
    await awaitPiReady(ctx, TMUX_NAME, { timeoutMs: 5000, pollMs: 10 });
    expect(calls.capturePane.length).toBeGreaterThan(0);
  });

  it('returns once a leading composer prompt glyph appears', async () => {
    const calls: FakeTmuxCalls = { capturePane: [] };
    const ctx = makeCtx(
      workerDir,
      fakeTmux(calls, () => '> '),
    );
    await awaitPiReady(ctx, TMUX_NAME, { timeoutMs: 5000, pollMs: 10 });
    expect(calls.capturePane.length).toBeGreaterThan(0);
  });

  it('returns after the timeout when no indicator appears (best-effort)', async () => {
    const calls: FakeTmuxCalls = { capturePane: [] };
    const ctx = makeCtx(
      workerDir,
      fakeTmux(calls, () => 'still booting, nothing useful here'),
    );
    // Must resolve (not throw, not hang) even though nothing matches.
    await awaitPiReady(ctx, TMUX_NAME, { timeoutMs: 50, pollMs: 10 });
    expect(calls.capturePane.length).toBeGreaterThan(0);
  });
});
