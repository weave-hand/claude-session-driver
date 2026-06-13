/**
 * Normalized turn model + shared markdown renderer + Claude transcript parser.
 *
 * PARSE is harness-specific: read a transcript's JSONL and produce a
 * NormalizedTurn. RENDER is shared: NormalizedTurn -> markdown. Codex and Pi
 * drivers will add their own parse functions producing the SAME NormalizedTurn
 * and reuse `renderTurn`.
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
