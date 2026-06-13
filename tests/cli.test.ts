import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

/** Capture stdout/stderr that `run` would write. */
function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('run — validation and dispatch', () => {
  let workerDir: string;
  let prevWorkerDir: string | undefined;

  beforeEach(() => {
    workerDir = mkdtempSync(join(tmpdir(), 'csd-cli-'));
    prevWorkerDir = process.env.CSD_WORKER_DIR;
    process.env.CSD_WORKER_DIR = workerDir;
  });

  afterEach(() => {
    if (prevWorkerDir === undefined) {
      delete process.env.CSD_WORKER_DIR;
    } else {
      process.env.CSD_WORKER_DIR = prevWorkerDir;
    }
    rmSync(workerDir, { recursive: true, force: true });
  });

  it('rejects --worker for a top-level subcommand', async () => {
    const { io, err } = makeIo();
    const code = await run(['--worker', 'w', 'launch'], io);
    expect(code).toBe(2);
    expect(err()).toContain(
      "Error: --worker is not valid for 'launch' (top-level subcommand)",
    );
  });

  it('requires --worker for a per-worker subcommand', async () => {
    const { io, err } = makeIo();
    const code = await run(['status'], io);
    expect(code).toBe(2);
    expect(err()).toContain("Error: --worker <name> is required for 'status'");
  });

  it('errors when --worker has no value', async () => {
    const { io, err } = makeIo();
    const code = await run(['--worker'], io);
    expect(code).toBe(2);
    expect(err()).toContain('Error: --worker requires a value');
  });

  it('rejects an unknown subcommand with usage', async () => {
    const { io, err } = makeIo();
    const code = await run(['bogus'], io);
    expect(code).toBe(2);
    expect(err()).toContain("Error: unknown subcommand 'bogus'");
    expect(err()).toContain('Usage: csd <subcommand>');
  });

  it('prints usage to stderr when no subcommand is given', async () => {
    const { io, err, out } = makeIo();
    const code = await run([], io);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: csd <subcommand>');
    expect(out()).toBe('');
  });

  it('prints usage to stdout for help (code 0)', async () => {
    const { io, out, err } = makeIo();
    const code = await run(['help'], io);
    expect(code).toBe(0);
    expect(out()).toContain('Usage: csd <subcommand>');
    expect(err()).toBe('');
  });

  it('usage text references the new /tmp/csd-workers default and lists subcommands', async () => {
    const { io, out } = makeIo();
    await run(['help'], io);
    const usage = out();
    expect(usage).toContain('/tmp/csd-workers');
    expect(usage).not.toContain('/tmp/claude-workers');
    for (const sub of [
      'launch',
      'adopt',
      'list',
      'grant-consent',
      'converse',
      'send',
      'wait-for-turn',
      'status',
      'read-events',
      'read-turn',
      'stop',
      'handoff',
      'session-id',
      'events-file',
    ]) {
      expect(usage).toContain(sub);
    }
  });

  it('dispatches list to cmdList (no workers) via ctx wiring', async () => {
    const { io, err, out } = makeIo();
    const code = await run(['list'], io);
    expect(code).toBe(0);
    expect(err()).toContain('No workers found');
    expect(out()).toBe('');
  });

  it('dispatches status to cmdStatus and returns its code for an unknown worker', async () => {
    const { io, err } = makeIo();
    const code = await run(['--worker', 'nope', 'status'], io);
    expect(code).toBe(1);
    expect(err()).toContain("Error: no worker known as 'nope'");
  });

  it('reports a usage error for launch missing positionals', async () => {
    const { io, err } = makeIo();
    const code = await run(['launch'], io);
    expect(code).toBe(2);
    expect(err()).toContain(
      'Usage: launch <tmux-name> <cwd> [-- claude-args...]',
    );
  });

  it('reports a usage error for adopt missing positionals', async () => {
    const { io, err } = makeIo();
    const code = await run(['adopt', 'name'], io);
    expect(code).toBe(2);
    expect(err()).toContain(
      'Usage: adopt <tmux-name> <cwd> <session-id> [-- claude-args...]',
    );
  });

  it('rejects unknown options for list', async () => {
    const { io, err } = makeIo();
    const code = await run(['list', '--bogus'], io);
    expect(code).toBe(2);
    expect(err()).toContain("Error: unknown option '--bogus' for list");
  });

  it('rejects more than one pattern for list', async () => {
    const { io, err } = makeIo();
    const code = await run(['list', 'a', 'b'], io);
    expect(code).toBe(2);
    expect(err()).toContain('Error: list takes at most one pattern argument');
  });

  it('rejects unknown options for read-events', async () => {
    const { io, err } = makeIo();
    const code = await run(['--worker', 'w', 'read-events', '--bogus'], io);
    expect(code).toBe(2);
    expect(err()).toContain("Error: unknown option '--bogus' for read-events");
  });

  it('rejects unknown options for wait-for-turn', async () => {
    const { io, err } = makeIo();
    const code = await run(['--worker', 'w', 'wait-for-turn', '--bogus'], io);
    expect(code).toBe(2);
    expect(err()).toContain(
      "Error: unknown option '--bogus' for wait-for-turn",
    );
  });

  it('requires a prompt for converse (return 1)', async () => {
    const { io, err } = makeIo();
    const code = await run(['--worker', 'w', 'converse'], io);
    expect(code).toBe(1);
    expect(err()).toContain(
      'Usage: converse [--with-turn] <prompt> [timeout=120]',
    );
  });

  it('requires a prompt for send (return 1)', async () => {
    const { io, err } = makeIo();
    const code = await run(['--worker', 'w', 'send'], io);
    expect(code).toBe(1);
    expect(err()).toContain('Usage: send <prompt>');
  });

  it('accepts --worker=value form', async () => {
    const { io, err } = makeIo();
    const code = await run(['--worker=nope', 'status'], io);
    expect(code).toBe(1);
    expect(err()).toContain("Error: no worker known as 'nope'");
  });
});
