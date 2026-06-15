import { type Runner, run as realRun } from './proc.js';

/** Expand an env record into flat `-e KEY=VALUE` pairs for tmux new-session/respawn-pane. */
function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

export function makeTmux(run: Runner = realRun) {
  return {
    /** Returns true if the named session exists, false otherwise. Never throws. */
    async hasSession(name: string): Promise<boolean> {
      try {
        const result = await run('tmux', ['has-session', '-t', name]);
        return result.code === 0;
      } catch {
        return false;
      }
    },

    async killSession(name: string): Promise<void> {
      await run('tmux', ['kill-session', '-t', name]);
    },

    /** Returns the captured pane text. */
    async capturePane(name: string): Promise<string> {
      const result = await run('tmux', ['capture-pane', '-t', name, '-p']);
      return result.stdout;
    },

    /** Returns the captured pane text including the full scrollback history. */
    async capturePaneFull(name: string): Promise<string> {
      const result = await run('tmux', [
        'capture-pane',
        '-t',
        name,
        '-p',
        '-S',
        '-',
        '-E',
        '-',
      ]);
      return result.stdout;
    },

    /** Send text literally to the pane (no key-name interpretation). */
    async sendText(name: string, text: string): Promise<void> {
      await run('tmux', ['send-keys', '-t', name, '-l', text]);
    },

    /** Send the Enter key to the pane. */
    async sendEnter(name: string): Promise<void> {
      await run('tmux', ['send-keys', '-t', name, 'Enter']);
    },

    /** Send a named key (e.g. 'Down', 'Up') to the pane. */
    async sendKey(name: string, key: string): Promise<void> {
      await run('tmux', ['send-keys', '-t', name, key]);
    },

    /** Create a new detached session running the given argv with the given env. */
    async newSession(
      name: string,
      cwd: string,
      env: Record<string, string>,
      argv: string[],
    ): Promise<void> {
      await run('tmux', [
        'new-session',
        '-d',
        '-s',
        name,
        '-c',
        cwd,
        ...envArgs(env),
        ...argv,
      ]);
    },

    /** Respawn the current pane in an existing session (used by adopt). */
    async respawnPane(
      name: string,
      cwd: string,
      env: Record<string, string>,
      argv: string[],
    ): Promise<void> {
      await run('tmux', [
        'respawn-pane',
        '-k',
        '-t',
        name,
        '-c',
        cwd,
        ...envArgs(env),
        ...argv,
      ]);
    },
  };
}

/** The type of the tmux client object returned by makeTmux. */
export type Tmux = ReturnType<typeof makeTmux>;

/** Default real tmux instance. */
export const tmux = makeTmux();
