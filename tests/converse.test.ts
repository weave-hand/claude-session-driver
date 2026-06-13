import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdConverse } from '../src/commands/converse.js';
import { appendEvent } from '../src/core/event-log.js';
import { claudeTranscriptPath, eventsPath } from '../src/core/paths.js';
import type { Tmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const SID = 'sid-converse';
const TMUX_NAME = 'converse-worker';
const CWD = '/home/user/project';

const ASSISTANT_BEFORE =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"earlier reply"}]}}';
const USER_PROMPT = '{"type":"user","message":{"content":"do the thing"}}';
const ASSISTANT_AFTER =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"the fresh answer"}]}}';

function transcriptFile(home: string): string {
  return claudeTranscriptPath(home, CWD, SID);
}

function writeTranscript(home: string, content: string): void {
  const p = transcriptFile(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/**
 * A fake tmux that, on `sendEnter`, simulates the worker accepting the prompt:
 * appends the `user_prompt_submit` (so cmdSend confirms) and a `stop` event (so
 * cmdWaitForTurn sees the turn end), and runs an optional `onTurn` hook to grow
 * the transcript.
 */
function respondingTmux(eventFile: string, onTurn?: () => void): Tmux {
  let responded = false;
  return {
    async hasSession() {
      return true;
    },
    async killSession() {},
    async capturePane() {
      return '';
    },
    async capturePaneFull() {
      return '';
    },
    async sendText() {},
    async sendEnter() {
      if (responded) return;
      responded = true;
      appendEvent(eventFile, {
        event: 'user_prompt_submit',
        ts: '2025-01-01T00:00:01Z',
      });
      appendEvent(eventFile, { event: 'stop', ts: '2025-01-01T00:00:02Z' });
      onTurn?.();
    },
    async sendKey() {},
    async newSession() {},
    async respawnPane() {},
  };
}

function deadTmux(): Tmux {
  return {
    async hasSession() {
      return false;
    },
    async killSession() {},
    async capturePane() {
      return '';
    },
    async capturePaneFull() {
      return '';
    },
    async sendText() {},
    async sendEnter() {},
    async sendKey() {},
    async newSession() {},
    async respawnPane() {},
  };
}

function makeCtx(workerDir: string, home: string, tmux: Tmux): CommandContext {
  return { workerDir, home, tmux, driver: getDriver('claude') };
}

const fastOpts = {
  timeout: 5,
  sendOpts: { submitTimeout: 5, retryInterval: 2, pollMs: 5 },
  waitPollMs: 5,
  postPollCount: 20,
  postPollMs: 5,
};

describe('cmdConverse', () => {
  let workerDir: string;
  let home: string;

  beforeEach(() => {
    workerDir = tmpDir('csd-conv-wd-');
    home = tmpDir('csd-conv-home-');
    writeMeta(workerDir, {
      tmux_name: TMUX_NAME,
      session_id: SID,
      cwd: CWD,
      harness: 'claude',
    });
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
    rmSync(home, { recursive: true });
    delete process.env.CSD_CONVERSE_DIAG_FILE;
  });

  it('returns the last assistant text on the happy path', async () => {
    const ef = eventsPath(workerDir, SID);
    writeTranscript(home, [ASSISTANT_BEFORE, USER_PROMPT].join('\n'));
    const tmux = respondingTmux(ef, () => {
      writeTranscript(
        home,
        [ASSISTANT_BEFORE, USER_PROMPT, ASSISTANT_AFTER].join('\n'),
      );
    });
    const ctx = makeCtx(workerDir, home, tmux);
    const result = await cmdConverse(ctx, SID, 'do the thing', fastOpts);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('the fresh answer');
  });

  it('--with-turn returns the rendered markdown turn', async () => {
    const ef = eventsPath(workerDir, SID);
    writeTranscript(home, [ASSISTANT_BEFORE, USER_PROMPT].join('\n'));
    const tmux = respondingTmux(ef, () => {
      writeTranscript(
        home,
        [ASSISTANT_BEFORE, USER_PROMPT, ASSISTANT_AFTER].join('\n'),
      );
    });
    const ctx = makeCtx(workerDir, home, tmux);
    const result = await cmdConverse(ctx, SID, 'do the thing', {
      ...fastOpts,
      withTurn: true,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('**Prompt:** do the thing');
    expect(result.stdout).toContain('the fresh answer');
  });

  it('errors when meta has no cwd', async () => {
    const wd = tmpDir('csd-conv-nocwd-');
    writeMeta(wd, {
      tmux_name: 'nc',
      session_id: 'sid-nc',
      cwd: '',
      harness: 'claude',
    });
    const ctx = makeCtx(wd, home, deadTmux());
    const result = await cmdConverse(ctx, 'sid-nc', 'hi', fastOpts);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'Error: Could not determine working directory from meta file',
    );
    rmSync(wd, { recursive: true });
  });

  it('propagates a send failure (no tmux session)', async () => {
    writeTranscript(home, [ASSISTANT_BEFORE, USER_PROMPT].join('\n'));
    const ctx = makeCtx(workerDir, home, deadTmux());
    const result = await cmdConverse(ctx, SID, 'hi', fastOpts);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `Error: tmux session '${TMUX_NAME}' does not exist`,
    );
  });

  it('errors and writes a diag file when the turn times out', async () => {
    writeTranscript(home, [ASSISTANT_BEFORE, USER_PROMPT].join('\n'));
    const ef = eventsPath(workerDir, SID);
    // sendEnter confirms submission but never emits a stop, so wait-for-turn
    // times out.
    const tmux: Tmux = {
      async hasSession() {
        return true;
      },
      async killSession() {},
      async capturePane() {
        return '';
      },
      async capturePaneFull() {
        return '';
      },
      async sendText() {},
      async sendEnter() {
        appendEvent(ef, {
          event: 'user_prompt_submit',
          ts: '2025-01-01T00:00:01Z',
        });
      },
      async sendKey() {},
      async newSession() {},
      async respawnPane() {},
    };
    const diagFile = join(home, 'diag.txt');
    process.env.CSD_CONVERSE_DIAG_FILE = diagFile;
    const ctx = makeCtx(workerDir, home, tmux);
    const result = await cmdConverse(ctx, SID, 'hi', {
      ...fastOpts,
      timeout: 0.1,
      now: () => '2026-06-13T00:00:00Z',
      diagRun: async () => ({ stdout: 'PS\n', stderr: '', code: 0 }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Error: Worker did not finish within 0.1s');
    expect(result.stderr).toContain(`csd-diagnostic: ${diagFile}`);
    expect(readFileSync(diagFile, 'utf8')).toContain(
      'reason=wait_for_turn_timeout',
    );
  });

  it('errors and writes a diag when no new assistant text appears', async () => {
    const ef = eventsPath(workerDir, SID);
    // Transcript never grows: turn ends but no new assistant text message.
    writeTranscript(home, [ASSISTANT_BEFORE, USER_PROMPT].join('\n'));
    const tmux = respondingTmux(ef);
    const diagFile = join(home, 'diag.txt');
    process.env.CSD_CONVERSE_DIAG_FILE = diagFile;
    const ctx = makeCtx(workerDir, home, tmux);
    const result = await cmdConverse(ctx, SID, 'hi', {
      ...fastOpts,
      postPollCount: 3,
      postPollMs: 5,
      now: () => '2026-06-13T00:00:00Z',
      diagRun: async () => ({ stdout: 'PS\n', stderr: '', code: 0 }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: Timed out waiting for assistant response in session log',
    );
    expect(result.stderr).toContain(`csd-diagnostic: ${diagFile}`);
    expect(readFileSync(diagFile, 'utf8')).toContain(
      'reason=no_assistant_response',
    );
  });
});
