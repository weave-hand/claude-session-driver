/**
 * Normalized turn model + shared markdown renderer + Claude transcript parser.
 *
 * PARSE is harness-specific: read a transcript's JSONL and produce a
 * NormalizedTurn. RENDER is shared: NormalizedTurn -> markdown. `parseClaudeTurn`
 * and `parseCodexTurn` both produce the SAME NormalizedTurn and reuse
 * `renderTurn`; the Pi driver will add its own parse the same way.
 *
 * This is a character-for-character port of the jq pipeline in the bash `csd`
 * (skills/driving-claude-code-sessions/scripts/csd). jq `-r` prints each emitted
 * string followed by a newline, so each rendered chunk (already ending in `\n`)
 * is followed by one more `\n` — see `renderTurn`.
 */

export type TurnItem =
  | { kind: 'prompt'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; input: unknown }
  | { kind: 'tool_result'; content: string; isError: boolean };

export type NormalizedTurn = TurnItem[];

const COMMAND_PREFIX = /^<(local-command|command-name)/;
const NO_OUTPUT = '(no output)';

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface TranscriptLine {
  type?: unknown;
  message?: { content?: unknown };
}

function parseLines(jsonl: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // Real transcripts can contain partial/garbage lines; skip them.
    }
  }
  return out;
}

/** True for a `"type":"user"` line whose content is a real prompt string. */
function isPromptBoundary(line: TranscriptLine): boolean {
  if (line.type !== 'user') return false;
  const content = line.message?.content;
  return typeof content === 'string' && !COMMAND_PREFIX.test(content);
}

function findBoundary(lines: TranscriptLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isPromptBoundary(lines[i] as TranscriptLine)) return i;
  }
  return -1;
}

/**
 * Mirror jq's `.content // "(no output)"`: yield `(no output)` when content is
 * null/undefined; otherwise coerce to string. (An empty string passes through in
 * jq's `//`; we treat only null/undefined as missing for parity simplicity.)
 */
function resultContent(content: unknown): string {
  if (content === null || content === undefined) return NO_OUTPUT;
  return String(content);
}

/**
 * Narrow a raw array element to a block object, or null if it isn't one.
 * Real transcripts can contain partial/garbage array elements (null, numbers,
 * strings); mirror `parseLines`' graceful-degradation by skipping them rather
 * than throwing on `block.type`.
 */
function asBlock(x: unknown): ContentBlock | null {
  return typeof x === 'object' && x !== null ? (x as ContentBlock) : null;
}

function collectUser(line: TranscriptLine, out: NormalizedTurn): void {
  const content = line.message?.content;
  if (typeof content === 'string') {
    if (!COMMAND_PREFIX.test(content))
      out.push({ kind: 'prompt', text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const raw of content as unknown[]) {
    const block = asBlock(raw);
    if (!block) continue;
    if (block.type !== 'tool_result') continue;
    out.push({
      kind: 'tool_result',
      content: resultContent(block.content),
      isError: Boolean(block.is_error),
    });
  }
}

function collectAssistant(line: TranscriptLine, out: NormalizedTurn): void {
  const content = line.message?.content;
  if (!Array.isArray(content)) return;
  // A missing `thinking`/`text`/`name` field renders as an empty string rather
  // than the literal "undefined": graceful empty is clearer than jq's behavior
  // of dropping the whole turn when such a field is absent.
  for (const raw of content as unknown[]) {
    const block = asBlock(raw);
    if (!block) continue;
    if (block.type === 'thinking') {
      const text = typeof block.thinking === 'string' ? block.thinking : '';
      out.push({ kind: 'thinking', text });
    } else if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      out.push({ kind: 'text', text });
    } else if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : '';
      out.push({
        kind: 'tool_use',
        name,
        input: block.input,
      });
    }
  }
}

export function parseClaudeTurn(jsonl: string): NormalizedTurn {
  const lines = parseLines(jsonl);
  const boundary = findBoundary(lines);
  if (boundary < 0) return [];

  const turn: NormalizedTurn = [];
  for (const line of lines.slice(boundary)) {
    if (line.type === 'user') collectUser(line, turn);
    else if (line.type === 'assistant') collectAssistant(line, turn);
  }
  return turn;
}

/**
 * Codex rollout parse. The rollout is JSONL of `{"type":"response_item",...}`
 * and `{"type":"event_msg",...}` lines. Parity with the bash `harness_parse_turn`
 * jq pipeline (drivers/codex.sh), normalized into the SHARED TurnItem model so
 * `renderTurn` works unchanged.
 *
 * Turn start = the last `response_item` with `payload.role == "user"`; if none,
 * start from line 1. From there each `response_item` maps:
 *   message(role=user)      -> prompt   (bash rendered `**[user]**`; we map to
 *   message(role!=user)     -> text      the existing kinds so the shared
 *   reasoning               -> thinking  renderer applies — see driver docs)
 *   function_call           -> tool_use   (arguments passed through: string or object)
 *   function_call_output    -> tool_result (output coerced to string, isError:false)
 * Anything else (and `event_msg`) is skipped. Parsing is defensive: malformed
 * lines, non-object payloads, and missing fields degrade to empty/skip, never throw.
 */

interface RolloutLine {
  type?: unknown;
  payload?: unknown;
}

interface RolloutPayload {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  summary?: unknown;
  name?: unknown;
  arguments?: unknown;
  output?: unknown;
}

function parseRolloutLines(jsonl: string): RolloutLine[] {
  const out: RolloutLine[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      // Codex rollout JSONL can contain bare scalars; the object guard prevents
      // treating them as line objects (unlike Claude transcripts which are always objects).
      if (typeof parsed === 'object' && parsed !== null) {
        out.push(parsed as RolloutLine);
      }
    } catch {
      // Real rollouts can contain partial/garbage lines; skip them.
    }
  }
  return out;
}

function asPayload(line: RolloutLine): RolloutPayload | null {
  if (line.type !== 'response_item') return null;
  const p = line.payload;
  return typeof p === 'object' && p !== null ? (p as RolloutPayload) : null;
}

/** Join `content[].text` / `content[].output_text` of a codex message payload. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .map((raw) => {
      const block = asBlock(raw);
      if (!block) return '';
      if (typeof block.text === 'string') return block.text;
      const out = (block as { output_text?: unknown }).output_text;
      return typeof out === 'string' ? out : '';
    })
    .join('');
}

/** Join the `text` of each reasoning `summary[]` entry (or the entry itself). */
function reasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) return '';
  return (summary as unknown[])
    .map((raw) => {
      if (typeof raw === 'string') return raw;
      const block = asBlock(raw);
      return block && typeof block.text === 'string' ? block.text : '';
    })
    .join(' ');
}

/** Index of the last user `response_item` message, or 0 to start from line 1. */
function findCodexBoundary(lines: RolloutLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = asPayload(lines[i] as RolloutLine);
    if (p && p.type === 'message' && p.role === 'user') return i;
  }
  return 0;
}

export function parseCodexTurn(jsonl: string): NormalizedTurn {
  const lines = parseRolloutLines(jsonl);
  if (lines.length === 0) return [];
  const boundary = findCodexBoundary(lines);

  const turn: NormalizedTurn = [];
  for (const line of lines.slice(boundary)) {
    const p = asPayload(line);
    if (!p) continue;
    if (p.type === 'message') {
      const text = messageText(p.content);
      if (p.role === 'user') turn.push({ kind: 'prompt', text });
      else turn.push({ kind: 'text', text });
    } else if (p.type === 'reasoning') {
      turn.push({ kind: 'thinking', text: reasoningText(p.summary) });
    } else if (p.type === 'function_call') {
      const name = typeof p.name === 'string' ? p.name : '';
      turn.push({ kind: 'tool_use', name, input: p.arguments });
    } else if (p.type === 'function_call_output') {
      turn.push({
        kind: 'tool_result',
        content: resultContent(p.output),
        isError: false,
      });
    }
  }
  return turn;
}

/** Compact JSON for an object; the raw string for a string (jq `tostring`). */
function compactJson(input: unknown): string {
  if (typeof input === 'string') return input;
  return JSON.stringify(input);
}

function truncate(content: string): string {
  const ls = content.split('\n');
  if (ls.length > 5) {
    return `${ls.slice(0, 5).join('\n')}\n... (${ls.length} lines total)`;
  }
  return ls.join('\n');
}

function renderItem(item: TurnItem, full: boolean): string {
  switch (item.kind) {
    case 'prompt':
      return `---\n\n**Prompt:** ${item.text}\n`;
    case 'thinking':
      return `> **Thinking:** ${item.text.split('\n').join('\n> ')}\n`;
    case 'text':
      return `${item.text}\n`;
    case 'tool_use':
      return `**Tool: ${item.name}**\n\`\`\`json\n${compactJson(item.input)}\n\`\`\`\n`;
    case 'tool_result': {
      if (item.isError) {
        return `**Tool Error:**\n\`\`\`\n${item.content}\n\`\`\`\n`;
      }
      const body = full ? item.content : truncate(item.content);
      return `**Result:**\n\`\`\`\n${body}\n\`\`\`\n`;
    }
  }
}

export function renderTurn(
  turn: NormalizedTurn,
  opts: { full: boolean },
): string {
  // jq `-r` prints each emitted string followed by a newline; each chunk already
  // ends in `\n`, so the per-output separator adds one more `\n` per chunk.
  return turn.map((item) => `${renderItem(item, opts.full)}\n`).join('');
}
