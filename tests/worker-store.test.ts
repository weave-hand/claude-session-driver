import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  eventsPath,
  harnessMarkerPath,
  metaPath,
  shimPath,
} from '../src/core/paths.js';
import {
  listWorkers,
  readHarnessMarker,
  readMeta,
  removeWorker,
  resolveSession,
  writeHarnessMarker,
  writeMeta,
  writeShim,
} from '../src/core/worker-store.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'csd-store-'));
}

const FAKE_CSD = '/usr/local/bin/csd.cjs';

const baseMeta = {
  tmux_name: 'my-worker',
  session_id: 'sid-abc',
  cwd: '/home/user/project',
  harness: 'claude',
};

describe('writeMeta / readMeta', () => {
  it('round-trips the four required fields', () => {
    const dir = tmpDir();
    writeMeta(dir, baseMeta);
    const meta = readMeta(dir, 'sid-abc');
    expect(meta).not.toBeNull();
    expect(meta!.tmux_name).toBe('my-worker');
    expect(meta!.session_id).toBe('sid-abc');
    expect(meta!.cwd).toBe('/home/user/project');
    expect(meta!.harness).toBe('claude');
  });

  it('round-trips extra fields via index signature', () => {
    const dir = tmpDir();
    const withExtra = { ...baseMeta, plugin_dir: '/some/dir', extra_num: 42 };
    writeMeta(dir, withExtra);
    const meta = readMeta(dir, 'sid-abc');
    expect(meta!.plugin_dir).toBe('/some/dir');
    expect(meta!.extra_num).toBe(42);
  });

  it('returns null for a missing sid', () => {
    const dir = tmpDir();
    expect(readMeta(dir, 'no-such-sid')).toBeNull();
  });

  it('returns null for a non-existent dir', () => {
    expect(readMeta('/does/not/exist', 'sid')).toBeNull();
  });
});

describe('listWorkers', () => {
  it('returns all metas written to the dir', () => {
    const dir = tmpDir();
    writeMeta(dir, baseMeta);
    writeMeta(dir, { ...baseMeta, tmux_name: 'second', session_id: 'sid-def' });
    const workers = listWorkers(dir);
    expect(workers).toHaveLength(2);
    const sids = workers.map((w) => w.session_id).sort();
    expect(sids).toEqual(['sid-abc', 'sid-def']);
  });

  it('returns [] for a non-existent dir', () => {
    expect(listWorkers('/does/not/exist')).toEqual([]);
  });

  it('skips malformed .meta files', () => {
    const dir = tmpDir();
    writeMeta(dir, baseMeta);
    // write garbage into another .meta file
    writeFileSync(join(dir, 'bad-sid.meta'), 'not json at all');
    const workers = listWorkers(dir);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.session_id).toBe('sid-abc');
  });
});

describe('resolveSession', () => {
  it('returns the arg unchanged when a .meta file for that sid exists', () => {
    const dir = tmpDir();
    writeMeta(dir, baseMeta);
    expect(resolveSession(dir, 'sid-abc')).toBe('sid-abc');
  });

  it('returns the arg unchanged when a .events.jsonl file for that sid exists', () => {
    const dir = tmpDir();
    // write only the events file, no meta
    writeFileSync(eventsPath(dir, 'sid-only-events'), '');
    expect(resolveSession(dir, 'sid-only-events')).toBe('sid-only-events');
  });

  it('returns the session_id when given a tmux_name', () => {
    const dir = tmpDir();
    writeMeta(dir, baseMeta);
    expect(resolveSession(dir, 'my-worker')).toBe('sid-abc');
  });

  it('returns null for an unknown arg', () => {
    const dir = tmpDir();
    writeMeta(dir, baseMeta);
    expect(resolveSession(dir, 'does-not-exist')).toBeNull();
  });
});

describe('writeShim', () => {
  it('creates the shim at the expected shimPath', () => {
    const dir = tmpDir();
    const returned = writeShim(dir, 'my-worker', FAKE_CSD);
    expect(returned).toBe(shimPath(dir, 'my-worker'));
    // file must exist — statSync will throw if not
    expect(() => statSync(returned)).not.toThrow();
  });

  it('makes the shim executable', () => {
    const dir = tmpDir();
    const p = writeShim(dir, 'my-worker', FAKE_CSD);
    const mode = statSync(p).mode;
    // at least one execute bit set
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it('shim content execs node with the csdEntry and worker name', () => {
    const dir = tmpDir();
    const p = writeShim(dir, 'my-worker', FAKE_CSD);
    const content = readFileSync(p, 'utf8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain(`exec node "${FAKE_CSD}" --worker "my-worker"`);
  });
});

describe('removeWorker', () => {
  it('deletes meta, events, shim, and harness-marker files', () => {
    const dir = tmpDir();
    writeMeta(dir, baseMeta);
    writeFileSync(eventsPath(dir, 'sid-abc'), '');
    writeShim(dir, 'my-worker', FAKE_CSD);
    writeHarnessMarker(dir, 'my-worker', 'codex');

    removeWorker(dir, 'sid-abc', 'my-worker');

    expect(() => statSync(metaPath(dir, 'sid-abc'))).toThrow();
    expect(() => statSync(eventsPath(dir, 'sid-abc'))).toThrow();
    expect(() => statSync(shimPath(dir, 'my-worker'))).toThrow();
    expect(() => statSync(harnessMarkerPath(dir, 'my-worker'))).toThrow();
  });

  it('does not throw when files are already gone', () => {
    const dir = tmpDir();
    expect(() => removeWorker(dir, 'ghost-sid', 'ghost-worker')).not.toThrow();
  });
});

describe('writeHarnessMarker / readHarnessMarker', () => {
  it('round-trips the harness string', () => {
    const dir = tmpDir();
    writeHarnessMarker(dir, 'my-worker', 'codex');
    expect(readHarnessMarker(dir, 'my-worker')).toBe('codex');
  });

  it('returns null when the marker file does not exist', () => {
    const dir = tmpDir();
    expect(readHarnessMarker(dir, 'no-such-worker')).toBeNull();
  });

  it('returns null for an empty marker file (trim() || null)', () => {
    // The implementation does readFileSync(...).trim() || null, so an empty
    // or whitespace-only file returns null rather than an empty string.
    const dir = tmpDir();
    writeFileSync(harnessMarkerPath(dir, 'my-worker'), '   ');
    expect(readHarnessMarker(dir, 'my-worker')).toBeNull();
  });
});
