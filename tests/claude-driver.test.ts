import { describe, expect, it } from 'vitest';
import { claude, claudeWorkerEnv } from '../src/harness/claude.js';
import { getDriver } from '../src/harness/registry.js';

describe('registry getDriver', () => {
  it('returns the claude driver with the expected static fields', () => {
    const d = getDriver('claude');
    expect(d.id).toBe('claude');
    expect(d.idStrategy).toBe('assign');
    expect(d.controlPlane).toBe('hooks');
    expect(d.quitKeys).toBe('/exit');
  });

  it('throws a clear error for an unknown harness', () => {
    expect(() => getDriver('nope')).toThrow(/nope/);
    expect(() => getDriver('nope')).toThrow(/claude/);
  });
});

describe('claude.launchArgv', () => {
  it('builds a launch argv with --session-id and the parity flags', () => {
    const argv = claude.launchArgv('launch', 'SID', '/c', '/plug', '/home');
    expect(argv).toContain('--session-id');
    expect(argv).toContain('SID');
    expect(argv).toContain('--plugin-dir');
    expect(argv).toContain('/plug');
    expect(argv).toContain('--dangerously-skip-permissions');
    // The binary is argv[0] so the result can be passed straight to tmux.newSession.
    expect(argv[0]).toBe('claude');
    // --session-id appears, --resume does not, on the launch path.
    expect(argv).not.toContain('--resume');
  });

  it('uses --resume instead of --session-id on the adopt path', () => {
    const argv = claude.launchArgv('adopt', 'SID', '/c', '/plug', '/home');
    expect(argv).toContain('--resume');
    expect(argv).not.toContain('--session-id');
    expect(argv).toContain('SID');
  });
});

describe('claude.bin', () => {
  it('defaults to "claude"', () => {
    const prev = process.env.CSD_CLAUDE_BIN;
    delete process.env.CSD_CLAUDE_BIN;
    try {
      expect(claude.bin()).toBe('claude');
    } finally {
      if (prev !== undefined) process.env.CSD_CLAUDE_BIN = prev;
    }
  });

  it('honors CSD_CLAUDE_BIN', () => {
    const prev = process.env.CSD_CLAUDE_BIN;
    process.env.CSD_CLAUDE_BIN = '/opt/claude';
    try {
      expect(claude.bin()).toBe('/opt/claude');
      expect(claude.launchArgv('launch', 'S', '/c', '/p', '/h')[0]).toBe(
        '/opt/claude',
      );
    } finally {
      if (prev === undefined) delete process.env.CSD_CLAUDE_BIN;
      else process.env.CSD_CLAUDE_BIN = prev;
    }
  });
});

describe('claude.transcriptPath', () => {
  it('encodes cwd and names the file by session id', () => {
    expect(claude.transcriptPath('SID', '/Users/x/p', '/home')).toBe(
      '/home/.claude/projects/-Users-x-p/SID.jsonl',
    );
  });
});

describe('claude.parseTurn', () => {
  it('delegates to parseClaudeTurn', () => {
    const transcript = '{"type":"user","message":{"content":"do it"}}';
    const turn = claude.parseTurn(transcript);
    expect(turn).toEqual([{ kind: 'prompt', text: 'do it' }]);
  });
});

describe('claudeWorkerEnv', () => {
  it('pins SSE_PORT and all six provider vars empty when the controller env is empty', () => {
    const env = claudeWorkerEnv({});
    expect(env).toEqual({
      CLAUDE_CODE_SSE_PORT: '',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '',
      CLAUDE_CODE_USE_MANTLE: '',
    });
  });

  it('omits a provider var the controller has a non-empty value for', () => {
    const env = claudeWorkerEnv({ CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(env.CLAUDE_CODE_SSE_PORT).toBe('');
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    // the other five are still pinned empty
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe('');
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe('');
    expect(env.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBe('');
    expect(env.CLAUDE_CODE_USE_MANTLE).toBe('');
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('');
  });

  it('pins a provider var empty when the controller value is the empty string', () => {
    const env = claudeWorkerEnv({ CLAUDE_CODE_USE_BEDROCK: '' });
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('');
  });
});
