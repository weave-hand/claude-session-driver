import { describe, expect, it } from 'vitest';
import { parseClaudeTurn, renderTurn } from '../src/core/transcript.js';

describe('parseClaudeTurn / renderTurn', () => {
  it('renders the last turn with truncated tool result', () => {
    const lines = [
      '{"type":"user","message":{"content":"old"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ignore"}]}}',
      '{"type":"user","message":{"content":"do it"}}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"ok"},{"type":"tool_use","name":"Bash","input":{"cmd":"ls"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"a\\nb\\nc\\nd\\ne\\nf","is_error":false}]}}',
    ].join('\n');
    const turn = parseClaudeTurn(lines);
    const md = renderTurn(turn, { full: false });
    expect(md).toContain('**Prompt:** do it');
    expect(md).toContain('> **Thinking:** hmm');
    expect(md).toContain('**Tool: Bash**');
    expect(md).toContain('... (6 lines total)');
    expect(md).not.toContain('old');
  });

  it('renders all lines and no truncation marker with full=true', () => {
    const lines = [
      '{"type":"user","message":{"content":"do it"}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"a\\nb\\nc\\nd\\ne\\nf","is_error":false}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: true });
    expect(md).toContain('**Result:**\n```\na\nb\nc\nd\ne\nf\n```\n');
    expect(md).not.toContain('lines total');
  });

  it('renders is_error tool_result as Tool Error, not Result', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"boom","is_error":true}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: false });
    expect(md).toContain('**Tool Error:**\n```\nboom\n```\n');
    expect(md).not.toContain('**Result:**');
  });

  it('excludes command-shaped user strings from the boundary and skips them when after it', () => {
    const lines = [
      '{"type":"user","message":{"content":"<local-command-stdout>noise</local-command-stdout>"}}',
      '{"type":"user","message":{"content":"the real prompt"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"reply"}]}}',
      '{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}',
    ].join('\n');
    const turn = parseClaudeTurn(lines);
    const md = renderTurn(turn, { full: false });
    expect(md).toContain('**Prompt:** the real prompt');
    expect(md).toContain('reply');
    expect(md).not.toContain('noise');
    expect(md).not.toContain('/clear');
    // boundary is the real prompt, so only one prompt item exists
    expect(turn.filter((i) => i.kind === 'prompt')).toHaveLength(1);
  });

  it('renders tool_use object input as compact json', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"cmd":"ls"}}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: false });
    expect(md).toContain('**Tool: Bash**\n```json\n{"cmd":"ls"}\n```\n');
  });

  it('renders tool_use string input directly without quotes', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":"raw-string-input"}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: false });
    expect(md).toContain('**Tool: Edit**\n```json\nraw-string-input\n```\n');
  });

  it('uses (no output) for null tool_result content', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":null,"is_error":false}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: false });
    expect(md).toContain('**Result:**\n```\n(no output)\n```\n');
  });

  it('returns [] for empty input and renders empty string', () => {
    expect(parseClaudeTurn('')).toEqual([]);
    expect(renderTurn([], { full: false })).toBe('');
  });

  it('returns [] when there is no real user prompt', () => {
    const lines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}',
    ].join('\n');
    expect(parseClaudeTurn(lines)).toEqual([]);
  });

  it('skips lines that fail to parse without throwing', () => {
    const lines = [
      '{"type":"user","message":{"content":"do it"}}',
      'this is not json at all',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
    ].join('\n');
    const turn = parseClaudeTurn(lines);
    const md = renderTurn(turn, { full: false });
    expect(md).toContain('**Prompt:** do it');
    expect(md).toContain('ok');
  });

  it('matches the exact bash byte output for the canonical fixture', () => {
    const lines = [
      '{"type":"user","message":{"content":"do it"}}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"ok"},{"type":"tool_use","name":"Bash","input":{"cmd":"ls"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"a\\nb\\nc\\nd\\ne\\nf","is_error":false}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: false });
    const expected =
      '---\n\n**Prompt:** do it\n\n' +
      '> **Thinking:** hmm\n\n' +
      'ok\n\n' +
      '**Tool: Bash**\n```json\n{"cmd":"ls"}\n```\n\n' +
      '**Result:**\n```\na\nb\nc\nd\ne\n... (6 lines total)\n```\n\n';
    expect(md).toBe(expected);
  });

  it('joins multi-line thinking with quote prefix', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"line1\\nline2"}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: false });
    expect(md).toContain('> **Thinking:** line1\n> line2\n');
  });
});
