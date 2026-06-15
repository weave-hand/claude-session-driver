import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdReadTurn } from '../src/commands/read-turn.js';
import { claudeTranscriptPath } from '../src/core/paths.js';
import { makeTmux } from '../src/core/tmux.js';
import { writeMeta } from '../src/core/worker-store.js';
import { getDriver } from '../src/harness/registry.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const SID = 'sid-readturn';
const CWD = '/home/user/project';

function makeCtx(workerDir: string, home: string): CommandContext {
  return {
    workerDir,
    home,
    tmux: makeTmux(async () => ({ stdout: '', stderr: '', code: 0 })),
    driver: getDriver('claude'),
  };
}

/** Write a transcript at the exact path the claude driver computes. */
function writeTranscript(home: string, cwd: string, content: string): void {
  const p = claudeTranscriptPath(home, cwd, SID);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

describe('cmdReadTurn', () => {
  let workerDir: string;
  let home: string;

  beforeEach(() => {
    workerDir = tmpDir('csd-rt-wd-');
    home = tmpDir('csd-rt-home-');
    writeMeta(workerDir, {
      tmux_name: 'rt-worker',
      session_id: SID,
      cwd: CWD,
      harness: 'claude',
    });
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true });
    rmSync(home, { recursive: true });
  });

  it('renders the last turn as markdown (wires file -> parseTurn -> renderTurn)', async () => {
    const transcript = [
      '{"type":"user","message":{"content":"do it"}}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"ok"},{"type":"tool_use","name":"Bash","input":{"cmd":"ls"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"a\\nb\\nc\\nd\\ne\\nf","is_error":false}]}}',
    ].join('\n');
    writeTranscript(home, CWD, transcript);

    const result = await cmdReadTurn(makeCtx(workerDir, home), SID, {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('**Prompt:** do it');
    expect(result.stdout).toContain('> **Thinking:** hmm');
    expect(result.stdout).toContain('**Tool: Bash**');
    // default (non-full) truncates >5 line results
    expect(result.stdout).toContain('... (6 lines total)');
  });

  it('passes full:true through to renderTurn (no truncation)', async () => {
    const transcript = [
      '{"type":"user","message":{"content":"do it"}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"a\\nb\\nc\\nd\\ne\\nf","is_error":false}]}}',
    ].join('\n');
    writeTranscript(home, CWD, transcript);

    const result = await cmdReadTurn(makeCtx(workerDir, home), SID, {
      full: true,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('a\nb\nc\nd\ne\nf');
    expect(result.stdout).not.toContain('lines total');
  });

  it('returns code 1 when the transcript file does not exist', async () => {
    const result = await cmdReadTurn(makeCtx(workerDir, home), SID, {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Session log not found at');
    expect(result.stderr).toContain(claudeTranscriptPath(home, CWD, SID));
  });

  it('returns code 1 when meta has no cwd', async () => {
    const wd = tmpDir('csd-rt-nocwd-');
    writeMeta(wd, {
      tmux_name: 'nc-worker',
      session_id: 'sid-nocwd',
      cwd: '',
      harness: 'claude',
    });
    const result = await cmdReadTurn(makeCtx(wd, home), 'sid-nocwd', {});
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'Error: Could not determine working directory from meta file',
    );
    rmSync(wd, { recursive: true });
  });

  it('returns code 1 when no user prompt is found in the transcript', async () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}',
    ].join('\n');
    writeTranscript(home, CWD, transcript);

    const result = await cmdReadTurn(makeCtx(workerDir, home), SID, {});
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('No user prompt found in session log');
  });

  it('returns code 1 for an unknown worker', async () => {
    const result = await cmdReadTurn(makeCtx(workerDir, home), 'ghost', {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ghost');
  });
});
