import { type ExecFileException, execFile } from 'node:child_process';

export type RunResult = { stdout: string; stderr: string; code: number };

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

/**
 * Thin execFile wrapper that always resolves (never rejects).
 * On process exit with non-zero code, resolves with that code.
 * On spawn failure (ENOENT etc.), resolves with code 1 and the error in stderr.
 * This lets callers branch on `code` just like checking `$?` in bash.
 *
 * IMPORTANT: execFile with an args array never invokes a shell, making
 * shell-quoting/injection bugs impossible by construction.
 */
export const run: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const errCode = (err as ExecFileException).code;
        const code = typeof errCode === 'number' ? errCode : 1;
        resolve({ stdout: stdout ?? '', stderr: stderr || String(err), code });
      },
    );
  });
