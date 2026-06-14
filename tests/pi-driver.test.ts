import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderTurn } from '../src/core/transcript.js';
import { pi, piWorkerEnv } from '../src/harness/pi.js';
import { getDriver } from '../src/harness/registry.js';

describe('registry getDriver(pi)', () => {
  it('returns the pi driver with the expected static fields', () => {
    const d = getDriver('pi');
    expect(d.id).toBe('pi');
    expect(d.idStrategy).toBe('derive');
    expect(d.controlPlane).toBe('extension');
    expect(d.quitKeys).toBe('/quit');
  });

  it('still resolves claude and codex', () => {
    expect(getDriver('claude').id).toBe('claude');
    expect(getDriver('codex').id).toBe('codex');
  });
});

describe('pi.bin', () => {
  it('defaults to "pi"', () => {
    const prev = process.env.CSD_PI_BIN;
    delete process.env.CSD_PI_BIN;
    try {
      expect(pi.bin()).toBe('pi');
    } finally {
      if (prev !== undefined) process.env.CSD_PI_BIN = prev;
    }
  });

  it('honors CSD_PI_BIN', () => {
    const prev = process.env.CSD_PI_BIN;
    process.env.CSD_PI_BIN = '/opt/pi';
    try {
      expect(pi.bin()).toBe('/opt/pi');
    } finally {
      if (prev === undefined) delete process.env.CSD_PI_BIN;
      else process.env.CSD_PI_BIN = prev;
    }
  });
});

describe('pi.launchArgv', () => {
  let prevExt: string | undefined;
  let prevModel: string | undefined;
  let prevProvider: string | undefined;

  beforeEach(() => {
    prevExt = process.env.CSD_PI_EXTENSION_PATH;
    prevModel = process.env.CSD_PI_MODEL;
    prevProvider = process.env.CSD_PI_PROVIDER;
    process.env.CSD_PI_EXTENSION_PATH = '/plug/dist/pi-extension.mjs';
    delete process.env.CSD_PI_MODEL;
    delete process.env.CSD_PI_PROVIDER;
  });

  afterEach(() => {
    if (prevExt === undefined) delete process.env.CSD_PI_EXTENSION_PATH;
    else process.env.CSD_PI_EXTENSION_PATH = prevExt;
    if (prevModel === undefined) delete process.env.CSD_PI_MODEL;
    else process.env.CSD_PI_MODEL = prevModel;
    if (prevProvider === undefined) delete process.env.CSD_PI_PROVIDER;
    else process.env.CSD_PI_PROVIDER = prevProvider;
  });

  it('builds a session-dir + extension argv with the binary first', () => {
    const argv = pi.launchArgv('launch', 'SID', '/work', '/plug', '/home');
    expect(argv[0]).toBe('pi');
    const sd = argv.indexOf('--session-dir');
    expect(sd).toBeGreaterThanOrEqual(0);
    expect(argv[sd + 1]).toBe(join('/home', 'sessions'));
    const e = argv.indexOf('-e');
    expect(e).toBeGreaterThanOrEqual(0);
    expect(argv[e + 1]).toBe('/plug/dist/pi-extension.mjs');
  });

  it('omits --model and --provider when no model env is set', () => {
    const argv = pi.launchArgv('launch', 'SID', '/work', '/plug', '/home');
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--provider');
  });

  it('includes --model when CSD_PI_MODEL is set', () => {
    process.env.CSD_PI_MODEL = 'anthropic/claude';
    const argv = pi.launchArgv('launch', 'SID', '/work', '/plug', '/home');
    const m = argv.indexOf('--model');
    expect(m).toBeGreaterThanOrEqual(0);
    expect(argv[m + 1]).toBe('anthropic/claude');
  });

  it('includes --provider only alongside --model when CSD_PI_PROVIDER is set', () => {
    process.env.CSD_PI_MODEL = 'claude';
    process.env.CSD_PI_PROVIDER = 'anthropic';
    const argv = pi.launchArgv('launch', 'SID', '/work', '/plug', '/home');
    const p = argv.indexOf('--provider');
    expect(p).toBeGreaterThanOrEqual(0);
    expect(argv[p + 1]).toBe('anthropic');
  });

  it('does not pass --provider when CSD_PI_MODEL is unset even if provider is set', () => {
    process.env.CSD_PI_PROVIDER = 'anthropic';
    const argv = pi.launchArgv('launch', 'SID', '/work', '/plug', '/home');
    expect(argv).not.toContain('--provider');
    expect(argv).not.toContain('--model');
  });

  it('ignores mode/sid (pi derives its own id)', () => {
    const launch = pi.launchArgv('launch', 'A', '/work', '/p', '/h');
    const adopt = pi.launchArgv('adopt', 'B', '/work', '/p', '/h');
    expect(launch).toEqual(adopt);
  });

  it('honors CSD_PI_BIN as argv[0]', () => {
    const prev = process.env.CSD_PI_BIN;
    process.env.CSD_PI_BIN = '/opt/pi';
    try {
      expect(pi.launchArgv('launch', 'S', '/c', '/p', '/h')[0]).toBe('/opt/pi');
    } finally {
      if (prev === undefined) delete process.env.CSD_PI_BIN;
      else process.env.CSD_PI_BIN = prev;
    }
  });
});

describe('pi.workerEnv', () => {
  let prevWorkerDir: string | undefined;

  beforeEach(() => {
    prevWorkerDir = process.env.CSD_WORKER_DIR;
    process.env.CSD_WORKER_DIR = '/tmp/csd-test-workers';
  });

  afterEach(() => {
    if (prevWorkerDir === undefined) delete process.env.CSD_WORKER_DIR;
    else process.env.CSD_WORKER_DIR = prevWorkerDir;
  });

  it('sets PI_CODING_AGENT_DIR, CSD_WORKER_DIR, and CSD_TMUX_NAME', () => {
    const env = pi.workerEnv('/tmp/wh', 'worker-7', {});
    expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/wh');
    expect(env.CSD_WORKER_DIR).toBe('/tmp/csd-test-workers');
    expect(env.CSD_TMUX_NAME).toBe('worker-7');
  });

  it('delegates to piWorkerEnv', () => {
    expect(pi.workerEnv('/tmp/wh', 'w1', {})).toEqual(
      piWorkerEnv('/tmp/wh', 'w1'),
    );
  });
});

describe('pi.prepare', () => {
  let operatorPiDir: string;
  let workerHome: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    operatorPiDir = mkdtempSync(join(tmpdir(), 'pi-operator-'));
    workerHome = mkdtempSync(join(tmpdir(), 'pi-worker-'));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = operatorPiDir;
  });

  afterEach(() => {
    rmSync(operatorPiDir, { recursive: true, force: true });
    rmSync(workerHome, { recursive: true, force: true });
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it('stages auth.json from the operator pi dir into the worker home', async () => {
    writeFileSync(join(operatorPiDir, 'auth.json'), '{"token":"abc"}');
    await pi.prepare('w1', '/proj', workerHome);
    expect(readFileSync(join(workerHome, 'auth.json'), 'utf8')).toBe(
      '{"token":"abc"}',
    );
  });

  it('stages models.json and settings.json when present', async () => {
    writeFileSync(join(operatorPiDir, 'auth.json'), '{}');
    writeFileSync(join(operatorPiDir, 'models.json'), '{"m":1}');
    writeFileSync(join(operatorPiDir, 'settings.json'), '{"s":1}');
    await pi.prepare('w1', '/proj', workerHome);
    expect(readFileSync(join(workerHome, 'models.json'), 'utf8')).toBe(
      '{"m":1}',
    );
    expect(readFileSync(join(workerHome, 'settings.json'), 'utf8')).toBe(
      '{"s":1}',
    );
  });

  it('falls back to ~/.pi/agent when PI_CODING_AGENT_DIR is unset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-home-'));
    try {
      delete process.env.PI_CODING_AGENT_DIR;
      process.env.HOME = home;
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
      writeFileSync(join(home, '.pi', 'agent', 'auth.json'), '{"h":1}');
      await pi.prepare('w1', '/proj', workerHome);
      expect(readFileSync(join(workerHome, 'auth.json'), 'utf8')).toBe(
        '{"h":1}',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates the worker home and does not fail when auth is absent', async () => {
    const fresh = join(tmpdir(), `pi-fresh-${Date.now()}`);
    try {
      await expect(pi.prepare('w1', '/proj', fresh)).resolves.not.toThrow();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('pi.transcriptPath', () => {
  let workerDir: string;
  let prevWorkerDir: string | undefined;

  beforeEach(() => {
    workerDir = mkdtempSync(join(tmpdir(), 'pi-tp-'));
    prevWorkerDir = process.env.CSD_WORKER_DIR;
    process.env.CSD_WORKER_DIR = workerDir;
  });

  afterEach(() => {
    rmSync(workerDir, { recursive: true, force: true });
    if (prevWorkerDir === undefined) delete process.env.CSD_WORKER_DIR;
    else process.env.CSD_WORKER_DIR = prevWorkerDir;
  });

  it('reads transcript_path from the self-registered meta', () => {
    writeFileSync(
      join(workerDir, 'SID.meta'),
      JSON.stringify({ transcript_path: '/x/session.jsonl' }),
    );
    expect(pi.transcriptPath('SID', '/proj', '/home')).toBe('/x/session.jsonl');
  });

  it('returns empty string when meta is missing or lacks transcript_path', () => {
    expect(pi.transcriptPath('NOPE', '/proj', '/home')).toBe('');
    writeFileSync(join(workerDir, 'NO.meta'), JSON.stringify({ cwd: '/p' }));
    expect(pi.transcriptPath('NO', '/proj', '/home')).toBe('');
  });
});

describe('pi.parseTurn', () => {
  it('delegates to parsePiTurn and renders with the shared renderer', () => {
    const session = [
      JSON.stringify({ type: 'session', version: 3, id: 's', cwd: '/p' }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: 'do it' },
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      }),
    ].join('\n');
    const turn = pi.parseTurn(session);
    expect(turn).toEqual([
      { kind: 'prompt', text: 'do it' },
      { kind: 'text', text: 'ok' },
    ]);
    const md = renderTurn(turn, { full: false });
    expect(md).toContain('**Prompt:** do it');
    expect(md).toContain('ok');
  });
});
