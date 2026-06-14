import { describe, expect, it } from 'vitest';
import {
  parseClaudeTurn,
  parsePiTurn,
  renderTurn,
} from '../src/core/transcript.js';

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

  it('skips a null element in a user content array and renders the valid tool_result', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"user","message":{"content":[null,{"type":"tool_result","content":"ok","is_error":false}]}}',
    ].join('\n');
    const turn = parseClaudeTurn(lines);
    const md = renderTurn(turn, { full: false });
    expect(md).toContain('**Result:**\n```\nok\n```\n');
    expect(turn.filter((i) => i.kind === 'tool_result')).toHaveLength(1);
  });

  it('skips a null element in an assistant content array and renders the valid text', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"assistant","message":{"content":[null,{"type":"text","text":"hello"}]}}',
    ].join('\n');
    const turn = parseClaudeTurn(lines);
    const md = renderTurn(turn, { full: false });
    expect(md).toContain('hello');
    expect(turn.filter((i) => i.kind === 'text')).toHaveLength(1);
  });

  it('renders a text block with no .text field as empty, not "undefined"', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"assistant","message":{"content":[{"type":"text"}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: false });
    expect(md).not.toContain('undefined');
    expect(md).toBe('---\n\n**Prompt:** go\n\n\n\n');
  });

  it('renders a tool_use block with no .name as an empty name, not "undefined"', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"cmd":"ls"}}]}}',
    ].join('\n');
    const md = renderTurn(parseClaudeTurn(lines), { full: false });
    expect(md).toContain('**Tool: **');
    expect(md).not.toContain('undefined');
  });

  it('contributes no items when message.content is neither string nor array', () => {
    const lines = [
      '{"type":"user","message":{"content":"go"}}',
      '{"type":"assistant","message":{"content":42}}',
      '{"type":"user","message":{"content":42}}',
    ].join('\n');
    const turn = parseClaudeTurn(lines);
    const md = renderTurn(turn, { full: false });
    // Only the boundary prompt contributes; the numeric-content lines add nothing.
    expect(turn.filter((i) => i.kind === 'prompt')).toHaveLength(1);
    expect(md).toBe('---\n\n**Prompt:** go\n\n');
  });
});

describe('parsePiTurn / renderTurn', () => {
  /** A pi session header line (entry type "session"). */
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'sess-uuid',
    timestamp: '2026-06-13T00:00:00.000Z',
    cwd: '/proj',
  });

  /** A pi message entry wrapping an AgentMessage. */
  const msg = (message: unknown, id = 'abc12345') =>
    JSON.stringify({
      type: 'message',
      id,
      parentId: null,
      timestamp: '2026-06-13T00:00:01.000Z',
      message,
    });

  const userStr = (text: string) => msg({ role: 'user', content: text });
  const userArr = (text: string) =>
    msg({ role: 'user', content: [{ type: 'text', text }] });
  const assistant = (content: unknown[], stopReason = 'stop') =>
    msg({ role: 'assistant', content, stopReason });
  const toolResult = (text: string, isError = false) =>
    msg({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text }],
      isError,
    });

  it('parses a full pi turn into the normalized items', () => {
    const session = [
      header,
      assistant([{ type: 'text', text: 'earlier turn, ignored' }]),
      userStr('do the thing'),
      assistant([
        { type: 'thinking', thinking: 'let me think' },
        { type: 'text', text: 'here is my answer' },
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'read',
          arguments: { path: '/x' },
        },
      ]),
      toolResult('file contents'),
    ].join('\n');

    const turn = parsePiTurn(session);
    expect(turn).toEqual([
      { kind: 'prompt', text: 'do the thing' },
      { kind: 'thinking', text: 'let me think' },
      { kind: 'text', text: 'here is my answer' },
      { kind: 'tool_use', name: 'read', input: { path: '/x' } },
      { kind: 'tool_result', content: 'file contents', isError: false },
    ]);
  });

  it('treats an array-content user message as the prompt boundary', () => {
    const session = [
      header,
      userArr('the prompt'),
      assistant([{ type: 'text', text: 'reply' }]),
    ].join('\n');
    expect(parsePiTurn(session)).toEqual([
      { kind: 'prompt', text: 'the prompt' },
      { kind: 'text', text: 'reply' },
    ]);
  });

  it('renders the normalized turn with the shared renderer', () => {
    const session = [
      header,
      userStr('do it'),
      assistant([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'ok' },
        { type: 'toolCall', id: 'c', name: 'bash', arguments: { cmd: 'ls' } },
      ]),
      toolResult('out'),
    ].join('\n');
    const md = renderTurn(parsePiTurn(session), { full: true });
    expect(md).toContain('**Prompt:** do it');
    expect(md).toContain('> **Thinking:** hmm');
    expect(md).toContain('ok');
    expect(md).toContain('**Tool: bash**');
    expect(md).toContain('```json\n{"cmd":"ls"}\n```');
    expect(md).toContain('**Result:**');
    expect(md).toContain('out');
  });

  it('skips the session header line (it is never a boundary or item)', () => {
    const session = [header, assistant([{ type: 'text', text: 'hello' }])].join(
      '\n',
    );
    const turn = parsePiTurn(session);
    expect(turn).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('starts from the first message when there is no user message', () => {
    const session = [
      header,
      assistant([{ type: 'text', text: 'hello' }]),
      toolResult('result'),
    ].join('\n');
    expect(parsePiTurn(session)).toEqual([
      { kind: 'text', text: 'hello' },
      { kind: 'tool_result', content: 'result', isError: false },
    ]);
  });

  it('finds the LAST user message as the turn boundary', () => {
    const session = [
      header,
      userStr('first prompt'),
      assistant([{ type: 'text', text: 'first reply' }]),
      userStr('second prompt'),
      assistant([{ type: 'text', text: 'second reply' }]),
    ].join('\n');
    const turn = parsePiTurn(session);
    expect(turn).toEqual([
      { kind: 'prompt', text: 'second prompt' },
      { kind: 'text', text: 'second reply' },
    ]);
  });

  it('skips unknown entry types (model_change, thinking_level_change)', () => {
    const session = [
      header,
      userStr('go'),
      JSON.stringify({ type: 'model_change', model: 'x' }),
      JSON.stringify({ type: 'thinking_level_change', level: 'high' }),
      assistant([{ type: 'text', text: 'done' }]),
    ].join('\n');
    expect(parsePiTurn(session)).toEqual([
      { kind: 'prompt', text: 'go' },
      { kind: 'text', text: 'done' },
    ]);
  });

  it('skips malformed and non-object lines without throwing', () => {
    const session = [
      header,
      'not json at all',
      '42',
      'null',
      userStr('go'),
      '{"type":"message"}',
      assistant([{ type: 'text', text: 'done' }]),
    ].join('\n');
    expect(parsePiTurn(session)).toEqual([
      { kind: 'prompt', text: 'go' },
      { kind: 'text', text: 'done' },
    ]);
  });

  it('renders an isError toolResult as Tool Error', () => {
    const session = [header, userStr('go'), toolResult('boom', true)].join(
      '\n',
    );
    const turn = parsePiTurn(session);
    expect(turn).toContainEqual({
      kind: 'tool_result',
      content: 'boom',
      isError: true,
    });
    const md = renderTurn(turn, { full: false });
    expect(md).toContain('**Tool Error:**');
    expect(md).not.toContain('**Result:**');
  });

  it('joins multiple text blocks of a user array prompt', () => {
    const session = [
      header,
      msg({
        role: 'user',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      }),
    ].join('\n');
    expect(parsePiTurn(session)).toEqual([
      { kind: 'prompt', text: 'part one part two' },
    ]);
  });

  it('ignores non-text (image) blocks when joining content', () => {
    const session = [
      header,
      userStr('go'),
      assistant([
        { type: 'text', text: 'visible' },
        { type: 'image', source: 'data:...' },
      ]),
    ].join('\n');
    expect(parsePiTurn(session)).toEqual([
      { kind: 'prompt', text: 'go' },
      { kind: 'text', text: 'visible' },
    ]);
  });

  it('renders a thinking block with no thinking field as empty, not "undefined"', () => {
    const session = [
      header,
      userStr('go'),
      assistant([{ type: 'thinking' }]),
    ].join('\n');
    const md = renderTurn(parsePiTurn(session), { full: false });
    expect(md).not.toContain('undefined');
  });

  it('renders a toolCall with no name as an empty name, not "undefined"', () => {
    const session = [
      header,
      userStr('go'),
      assistant([{ type: 'toolCall', id: 'c', arguments: {} }]),
    ].join('\n');
    const md = renderTurn(parsePiTurn(session), { full: false });
    expect(md).toContain('**Tool: **');
    expect(md).not.toContain('undefined');
  });

  it('yields empty string (not "(no output)") for a null-content toolResult', () => {
    // Pi's toolResult content is always array-typed; null/non-array degrades to ''
    // rather than the '(no output)' fallback used for claude's bare-string-null.
    const session = [
      header,
      userStr('go'),
      msg({
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 't',
        content: null,
        isError: false,
      }),
    ].join('\n');
    const turn = parsePiTurn(session);
    expect(turn).toContainEqual({
      kind: 'tool_result',
      content: '',
      isError: false,
    });
  });

  it('returns [] for empty input', () => {
    expect(parsePiTurn('')).toEqual([]);
  });

  it('returns [] for a header-only session', () => {
    expect(parsePiTurn(header)).toEqual([]);
  });
});
