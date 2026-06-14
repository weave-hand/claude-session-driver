import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/context.js';
import { cmdGrantConsent } from '../src/commands/grant-consent.js';
import { consentPath, grantConsent } from '../src/core/consent.js';
import { makeTmux } from '../src/core/tmux.js';
import { getDriver } from '../src/harness/registry.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'csd-gc-home-'));
}

function makeCtx(home: string): CommandContext {
  return {
    workerDir: home,
    home,
    tmux: makeTmux(async () => ({ stdout: '', stderr: '', code: 0 })),
    driver: getDriver('claude'),
  };
}

describe('cmdGrantConsent', () => {
  let home: string;

  beforeEach(() => {
    home = tmpHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true });
  });

  it('reports already granted when consent file already exists', async () => {
    grantConsent(home);
    const result = await cmdGrantConsent(makeCtx(home), {
      confirm: async () => true,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already granted');
    expect(result.stdout).toContain(consentPath(home));
  });

  it('grants consent and reports success when confirm returns true', async () => {
    const result = await cmdGrantConsent(makeCtx(home), {
      confirm: async () => true,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Consent granted');
    expect(result.stdout).toContain(consentPath(home));
    expect(existsSync(consentPath(home))).toBe(true);
  });

  it('does not grant consent and returns code 1 when confirm returns false', async () => {
    const warned: string[] = [];
    const result = await cmdGrantConsent(makeCtx(home), {
      warn: (s) => warned.push(s),
      confirm: async () => false,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not granted');
    expect(warned.join('')).toContain('--dangerously-skip-permissions');
    expect(existsSync(consentPath(home))).toBe(false);
  });

  it('emits the full risk warning BEFORE prompting (bash prints, then reads)', async () => {
    const events: string[] = [];
    const result = await cmdGrantConsent(makeCtx(home), {
      warn: (s) => events.push(`warn:${s}`),
      confirm: async () => {
        events.push('confirm');
        return true;
      },
    });
    expect(result.code).toBe(0);
    // The warning must be emitted before confirm() prompts/reads.
    const warnIdx = events.findIndex((e) => e.startsWith('warn:'));
    const confirmIdx = events.indexOf('confirm');
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(confirmIdx).toBeGreaterThan(warnIdx);
    expect(events[warnIdx]).toContain('--dangerously-skip-permissions');
  });
});
