import { describe, expect, it } from 'vitest';
import { canonicalToolName } from '../src/core/tool-name.js';

describe('canonicalToolName', () => {
  it('title-cases the first letter so pi lowercase matches the Bash/Read convention', () => {
    expect(canonicalToolName('bash')).toBe('Bash');
    expect(canonicalToolName('read')).toBe('Read');
  });

  it('leaves an already-capitalized name unchanged', () => {
    expect(canonicalToolName('Bash')).toBe('Bash');
    expect(canonicalToolName('WebFetch')).toBe('WebFetch');
  });

  it('coerces empty / non-string (malformed payload) to an empty string', () => {
    expect(canonicalToolName('')).toBe('');
    expect(canonicalToolName(undefined)).toBe('');
    expect(canonicalToolName(null)).toBe('');
    expect(canonicalToolName(42)).toBe('');
  });
});
