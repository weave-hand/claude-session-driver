import { describe, expect, it, vi } from 'vitest';
import { makeTmux } from '../src/core/tmux.js';

describe('makeTmux', () => {
  const makeStub = () =>
    vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 });

  it('sends text as literal then Enter as separate calls', async () => {
    const run = makeStub();
    const tmux = makeTmux(run);
    await tmux.sendText('w', 'hello');
    await tmux.sendEnter('w');
    expect(run).toHaveBeenNthCalledWith(1, 'tmux', [
      'send-keys',
      '-t',
      'w',
      '-l',
      'hello',
    ]);
    expect(run).toHaveBeenNthCalledWith(2, 'tmux', [
      'send-keys',
      '-t',
      'w',
      'Enter',
    ]);
  });

  it('hasSession returns true when exit code is 0', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    const tmux = makeTmux(run);
    const result = await tmux.hasSession('mysession');
    expect(result).toBe(true);
    expect(run).toHaveBeenCalledWith('tmux', [
      'has-session',
      '-t',
      'mysession',
    ]);
  });

  it('hasSession returns false when exit code is non-zero', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 1 });
    const tmux = makeTmux(run);
    const result = await tmux.hasSession('nosession');
    expect(result).toBe(false);
    expect(run).toHaveBeenCalledWith('tmux', [
      'has-session',
      '-t',
      'nosession',
    ]);
  });

  it('hasSession returns false when runner rejects (does not throw)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn ENOENT'));
    const tmux = makeTmux(run);
    const result = await tmux.hasSession('dead');
    expect(result).toBe(false);
  });

  it('killSession sends correct argv', async () => {
    const run = makeStub();
    const tmux = makeTmux(run);
    await tmux.killSession('mysession');
    expect(run).toHaveBeenCalledWith('tmux', [
      'kill-session',
      '-t',
      'mysession',
    ]);
  });

  it('capturePane sends correct argv and returns stdout', async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: 'pane content\n', stderr: '', code: 0 });
    const tmux = makeTmux(run);
    const output = await tmux.capturePane('mysession');
    expect(run).toHaveBeenCalledWith('tmux', [
      'capture-pane',
      '-t',
      'mysession',
      '-p',
    ]);
    expect(output).toBe('pane content\n');
  });

  it('capturePaneFull captures full scrollback and returns stdout', async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ stdout: 'full\nscrollback\n', stderr: '', code: 0 });
    const tmux = makeTmux(run);
    const output = await tmux.capturePaneFull('mysession');
    expect(run).toHaveBeenCalledWith('tmux', [
      'capture-pane',
      '-t',
      'mysession',
      '-p',
      '-S',
      '-',
      '-E',
      '-',
    ]);
    expect(output).toBe('full\nscrollback\n');
  });

  it('sendKey sends a named key without -l flag', async () => {
    const run = makeStub();
    const tmux = makeTmux(run);
    await tmux.sendKey('mysession', 'Down');
    expect(run).toHaveBeenCalledWith('tmux', [
      'send-keys',
      '-t',
      'mysession',
      'Down',
    ]);
  });

  it('newSession builds argv with env expansion and program argv', async () => {
    const run = makeStub();
    const tmux = makeTmux(run);
    await tmux.newSession(
      'my-session',
      '/work/dir',
      { FOO: 'bar', BAZ: 'qux' },
      ['node', 'dist/index.js', '--flag'],
    );
    expect(run).toHaveBeenCalledWith('tmux', [
      'new-session',
      '-d',
      '-s',
      'my-session',
      '-c',
      '/work/dir',
      '-e',
      'FOO=bar',
      '-e',
      'BAZ=qux',
      'node',
      'dist/index.js',
      '--flag',
    ]);
  });

  it('newSession with empty env and argv works', async () => {
    const run = makeStub();
    const tmux = makeTmux(run);
    await tmux.newSession('s', '/tmp', {}, ['bash']);
    expect(run).toHaveBeenCalledWith('tmux', [
      'new-session',
      '-d',
      '-s',
      's',
      '-c',
      '/tmp',
      'bash',
    ]);
  });

  it('respawnPane builds argv with env expansion and program argv', async () => {
    const run = makeStub();
    const tmux = makeTmux(run);
    await tmux.respawnPane('my-session', '/work/dir', { KEY: 'val' }, [
      'node',
      'server.js',
    ]);
    expect(run).toHaveBeenCalledWith('tmux', [
      'respawn-pane',
      '-k',
      '-t',
      'my-session',
      '-c',
      '/work/dir',
      '-e',
      'KEY=val',
      'node',
      'server.js',
    ]);
  });
});
