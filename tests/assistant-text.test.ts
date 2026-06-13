import { describe, expect, it } from 'vitest';
import {
  countAssistantTextMessages,
  lastAssistantText,
} from '../src/core/assistant-text.js';

const lines = (...ls: string[]): string => ls.join('\n');

describe('countAssistantTextMessages', () => {
  it('counts only assistant messages with an array content containing text', () => {
    const t = lines(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"b"}]}}',
      '{"type":"user","message":{"content":"hi"}}',
    );
    expect(countAssistantTextMessages(t)).toBe(2);
  });

  it('returns 0 for an empty transcript', () => {
    expect(countAssistantTextMessages('')).toBe(0);
  });

  it('ignores assistant lines whose content is a string (not an array)', () => {
    const t =
      '{"type":"assistant","message":{"content":"plain string content"}}';
    expect(countAssistantTextMessages(t)).toBe(0);
  });

  it('skips garbage/partial JSONL lines', () => {
    const t = lines(
      'not json',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}',
    );
    expect(countAssistantTextMessages(t)).toBe(1);
  });
});

describe('lastAssistantText', () => {
  it('returns the text of the LAST assistant message that has text', () => {
    const t = lines(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}',
    );
    expect(lastAssistantText(t)).toBe('second');
  });

  it('joins multiple text blocks in the last message with newlines', () => {
    const t =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"line one"},{"type":"thinking","thinking":"x"},{"type":"text","text":"line two"}]}}';
    expect(lastAssistantText(t)).toBe('line one\nline two');
  });

  it('returns empty string when there is no assistant text message', () => {
    const t =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}';
    expect(lastAssistantText(t)).toBe('');
  });

  it('returns empty string for an empty transcript', () => {
    expect(lastAssistantText('')).toBe('');
  });
});
