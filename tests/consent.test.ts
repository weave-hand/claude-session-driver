import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consentPath, grantConsent, hasConsent } from '../src/core/consent.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'csd-consent-home-'));
}

describe('consentPath', () => {
  it('returns the correct path under $HOME/.claude', () => {
    const home = '/home/testuser';
    expect(consentPath(home)).toBe(
      '/home/testuser/.claude/.claude-session-driver-consent',
    );
  });
});

describe('hasConsent / grantConsent', () => {
  let home: string;

  beforeEach(() => {
    home = tmpHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true });
  });

  it('returns false before consent is granted', () => {
    expect(hasConsent(home)).toBe(false);
  });

  it('returns true after consent is granted', () => {
    grantConsent(home);
    expect(hasConsent(home)).toBe(true);
  });

  it('creates the consent file at the expected path', () => {
    grantConsent(home);
    expect(existsSync(consentPath(home))).toBe(true);
  });

  it('is idempotent — granting twice does not throw', () => {
    grantConsent(home);
    expect(() => grantConsent(home)).not.toThrow();
  });
});
