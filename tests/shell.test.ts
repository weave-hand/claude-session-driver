import { describe, expect, it } from 'vitest';
import { shellQuote, shellQuoteAlways } from '../src/core/shell.js';

/**
 * Pins the BEHAVIORAL DIFFERENCE between the two shell-quoting functions.
 * shellQuote has a safe-token fast path (for human-readable reproduce lines).
 * shellQuoteAlways has NO fast path (for args baked into re-evaluated strings).
 *
 * If a future consolidation removes the behavioral distinction, these tests
 * will catch it.
 */

describe('shellQuote (fast-path version)', () => {
  it('passes safe tokens through unquoted', () => {
    expect(shellQuote('worker1')).toBe('worker1');
    expect(shellQuote('/tmp/path-to_thing.js')).toBe('/tmp/path-to_thing.js');
    expect(shellQuote('safe_TOKEN')).toBe('safe_TOKEN');
    expect(shellQuote('a:b=c@d-e')).toBe('a:b=c@d-e');
  });

  it('quotes tokens with spaces', () => {
    expect(shellQuote('has space')).toBe("'has space'");
  });

  it('quotes tokens with special characters', () => {
    expect(shellQuote('a;b')).toBe("'a;b'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('returns empty string as two single quotes', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('shellQuoteAlways (no-fast-path version)', () => {
  it('always wraps safe tokens in single quotes — proving NO fast path', () => {
    // These are the same tokens shellQuote passes through unquoted.
    // shellQuoteAlways must wrap them to prove the behavioral difference is intact.
    expect(shellQuoteAlways('safe')).toBe("'safe'");
    expect(shellQuoteAlways('worker1')).toBe("'worker1'");
    expect(shellQuoteAlways('a:b=c@d-e')).toBe("'a:b=c@d-e'");
  });

  it('quotes tokens with spaces', () => {
    expect(shellQuoteAlways('has space')).toBe("'has space'");
  });

  it('escapes embedded single quotes with the POSIX trick', () => {
    expect(shellQuoteAlways("a'b")).toBe("'a'\\''b'");
    expect(shellQuoteAlways("it's")).toBe("'it'\\''s'");
  });

  it('wraps empty string in single quotes', () => {
    expect(shellQuoteAlways('')).toBe("''");
  });
});
