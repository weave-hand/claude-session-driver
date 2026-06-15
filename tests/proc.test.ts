import { describe, expect, it } from 'vitest';
import { run } from '../src/core/proc.js';

describe('run()', () => {
  it('resolves with code 0 and captured stdout on success', async () => {
    const result = await run('node', ['-e', 'process.stdout.write("hi")']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hi');
  });

  it('resolves with the actual exit code on non-zero exit', async () => {
    const result = await run('node', ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
  });

  it('resolves with code 1 and non-empty stderr on spawn failure (ENOENT)', async () => {
    const result = await run('definitely-not-a-real-binary-xyz', []);
    expect(result.code).toBe(1);
    expect(result.stderr).toBeTruthy();
    expect(result.stderr).toMatch(/definitely-not-a-real-binary-xyz/);
  });
});
