import { describe, expect, it } from 'vitest';
import {
  claudeTranscriptPath,
  ensureBackCompatSymlink,
  eventsPath,
  metaPath,
  shimPath,
  workerDir,
} from '../src/core/paths.js';

describe('workerDir', () => {
  it('returns /tmp/csd-workers by default when env var is unset', () => {
    const saved = process.env.CSD_WORKER_DIR;
    delete process.env.CSD_WORKER_DIR;
    try {
      expect(workerDir()).toBe('/tmp/csd-workers');
    } finally {
      if (saved !== undefined) process.env.CSD_WORKER_DIR = saved;
    }
  });

  it('returns the override when CSD_WORKER_DIR is set', () => {
    const saved = process.env.CSD_WORKER_DIR;
    process.env.CSD_WORKER_DIR = '/custom/workers';
    try {
      expect(workerDir()).toBe('/custom/workers');
    } finally {
      if (saved !== undefined) process.env.CSD_WORKER_DIR = saved;
      else delete process.env.CSD_WORKER_DIR;
    }
  });
});

describe('path builders', () => {
  it('builds events path', () => {
    expect(eventsPath('/d', 'SID')).toBe('/d/SID.events.jsonl');
  });

  it('builds meta path', () => {
    expect(metaPath('/d', 'SID')).toBe('/d/SID.meta');
  });

  it('builds shim path', () => {
    expect(shimPath('/d', 'my-worker')).toBe('/d/bin/my-worker');
  });

  it('encodes cwd slashes as dashes for the claude transcript path', () => {
    expect(claudeTranscriptPath('/h', '/Users/x/p', 'SID')).toBe(
      '/h/.claude/projects/-Users-x-p/SID.jsonl',
    );
  });
});

describe('ensureBackCompatSymlink', () => {
  it('is a no-op for a non-default dir (never throws)', () => {
    // Passing a random non-default dir must not attempt any filesystem operation
    expect(() => ensureBackCompatSymlink('/some/other/dir')).not.toThrow();
  });
});
