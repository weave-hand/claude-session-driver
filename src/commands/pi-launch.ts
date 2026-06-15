/**
 * Pi launch-time tmux wait. The pi analog of codex-launch's trust-gate/composer
 * dance — but far lighter, because pi has NO trust gate and no special launch
 * approval. The only thing csd waits for is that pi's TUI has come up and is
 * showing its prompt/status bar, so a subsequent `send` paste lands in a live
 * composer rather than racing the boot.
 *
 * Like the codex helpers, this lives in the command layer (not the HarnessDriver)
 * because it needs `ctx.tmux.capturePane` — context the driver's
 * `awaitReady(tmuxName, sessionId)` slot does not receive.
 *
 * BEST-EFFORT: pi is ready quickly once launched, and the REAL proof a pi worker
 * is usable is that its extension self-registers the meta on the first prompt
 * (mirroring codex). So this never throws and returns success on timeout — a
 * worker whose status bar never matched still "launches"; the first send
 * re-confirms via the extension's meta self-registration.
 */

import type { CommandContext } from './context.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Light ready window: pi's TUI comes up fast, so this is short. */
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_READY_POLL_MS = 250;

/**
 * Pi's prompt/status-bar readiness indicator. Once pi's TUI is up it draws a
 * status bar with a context-usage gauge like `0.0%/272k (auto)`, and a composer
 * prompt glyph. Match either the gauge (`<n>%/<n>k`) or a leading prompt glyph
 * (`>` / U+203A `›`) at the start of a line — any one means the composer is live.
 */
const PI_READY = /\d+(?:\.\d+)?%\/\d+k|^\s*[>›]/m;

export interface PiReadyOpts {
  /** Ready window in ms (default 10s — pi is fast to boot). */
  timeoutMs?: number;
  /** Poll interval in ms (default 250ms). */
  pollMs?: number;
}

/**
 * Block until pi's composer/status bar is visible in the pane, or settle after
 * the window. Best-effort: returns on timeout (no hard proof-of-life signal at
 * boot — the meta self-registers on the first prompt), never throws.
 */
export async function awaitPiReady(
  ctx: CommandContext,
  tmuxName: string,
  opts: PiReadyOpts = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_READY_POLL_MS;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = await capture(ctx, tmuxName);
    if (PI_READY.test(pane)) return;
    await sleep(pollMs);
  }
}

/** Capture the pane, treating a capture failure as an empty pane (best-effort). */
async function capture(ctx: CommandContext, tmuxName: string): Promise<string> {
  try {
    return await ctx.tmux.capturePane(tmuxName);
  } catch {
    return '';
  }
}
