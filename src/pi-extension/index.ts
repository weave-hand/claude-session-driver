/**
 * Pi coding-agent extension: the csd worker control plane for the Pi harness.
 *
 * Unlike Claude/Codex (lifecycle HOOKS that shell out to `emit-event.cjs`), Pi
 * has a native TypeScript extension API. This module will register `pi.on(...)`
 * handlers that map Pi lifecycle events to our `WorkerEvent` vocabulary and
 * APPEND them directly to `<workerDir>/<sid>.events.jsonl` (the SAME sink the
 * hooks write via `appendEvent` / `eventsPath`). C2 implements the handlers;
 * C3 wires the `pi` HarnessDriver. THIS FILE (C1) records the verified contract.
 *
 * ============================================================================
 * C1 — VERIFIED CONTRACT against the INSTALLED pi 0.74.0
 * (/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/)
 * Every claim below is cited to a pi source file. Items I could not confirm
 * from the installed pi are marked UNVERIFIED.
 * ============================================================================
 *
 * ----------------------------------------------------------------------------
 * 1. EXTENSION EXPORT SHAPE + REGISTRATION + FILE FORMAT  (VERIFIED)
 * ----------------------------------------------------------------------------
 * EXPORT SHAPE: a DEFAULT export factory function that receives the
 * `ExtensionAPI` (`pi`). Sync or async; if it returns a Promise pi awaits it
 * before `session_start`.
 *   `export default function (pi: ExtensionAPI) { pi.on(...); pi.registerTool(...); }`
 *   - docs/extensions.md §"Writing an Extension" (lines 154-180): "An extension
 *     exports a default factory function that receives `ExtensionAPI`."
 *   - examples/extensions/hello.ts, auto-commit-on-exit.ts: both
 *     `export default function (pi: ExtensionAPI) { ... }`.
 *   - Type: `ExtensionFactory` / `Extension` exported from the package
 *     (dist/index.d.ts line 6).
 *
 * REGISTRATION MECHANISM (two routes; we use the LAUNCH FLAG):
 *   - LAUNCH FLAG: `pi -e <path>` / `pi --extension <source>` (repeatable;
 *     path, npm, or git). docs/extensions.md line 102-106 + docs/usage.md
 *     §"Resource Options" line 194: "`-e`, `--extension <source>` Load an
 *     extension from path, npm, or git; repeatable". This is our mechanism —
 *     it does NOT require staging into the per-worker home's auto-discover dir.
 *   - AUTO-DISCOVER DIRS (alternative): `~/.pi/agent/extensions/*.ts` (global)
 *     or `.pi/extensions/*.ts` (project-local). docs/extensions.md lines 7,
 *     112-119. NOTE the global path is `~/.pi/agent/extensions/`, i.e. UNDER
 *     the agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`), NOT `~/.pi`.
 *   - `settings.json` `extensions: [...]` array (docs/extensions.md 121-134).
 *
 * FILE FORMAT — pi runs `.ts` DIRECTLY via its own transpiler (jiti). No
 * compilation step is required or expected by pi.
 *   - docs/extensions.md line 178: "Extensions are loaded via jiti
 *     (https://github.com/unjs/jiti), so TypeScript works without compilation."
 *   - All examples/extensions/*.ts are raw `.ts` loaded as-is; the quick-start
 *     and every `pi -e` invocation point at a `.ts` file.
 *
 * BUNDLE-TARGET DECISION (the key C1 call):
 *   Because pi loads via jiti and accepts `.ts` directly, the cleanest ship is
 *   a SINGLE SELF-CONTAINED `.ts` (or `.mjs`) we point `pi -e` at. jiti also
 *   transpiles/loads `.mjs`/ESM fine. Our package is `"type": "module"`
 *   (package.json) and pi's package is `"type": "module"` too, so an ESM bundle
 *   is the correct artifact — a CJS bundle (current tsup output `.cjs`) is the
 *   WRONG format for an ESM-default-export factory pi loads.
 *
 *   tsup TODO (RECORDED, not yet applied — see note at end of this block):
 *   change the `pi-extension` entry's output to ESM `dist/pi-extension.mjs`.
 *   The extension is self-contained (it must NOT import from our CJS `csd`
 *   bundle at pi-runtime; it imports only `node:fs`/`node:path` + inlines the
 *   tiny event-append + meta-write logic, OR C2/C3 bundle those helpers into
 *   the same ESM artifact). C2 owns the actual extension code; once that exists
 *   the ESM format flip + `dist:check` rebuild is a clean, single change.
 *
 * ----------------------------------------------------------------------------
 * 2. THE pi.on EVENT API + REAL EVENT NAMES + CORRECTED MAPPING  (VERIFIED)
 * ----------------------------------------------------------------------------
 * SUBSCRIBE METHOD: `pi.on(eventName, handler)`. Each handler is
 * `(event, ctx: ExtensionContext) => Promise<R | void> | R | void`.
 *   - Exact overloads in dist/core/extensions/types.d.ts lines 784-812
 *     (`interface ExtensionAPI`); `ExtensionHandler` type at line 779.
 *   - (`pi.events.on/emit` ALSO exists but is a SEPARATE inter-extension bus,
 *     NOT lifecycle events — docs/extensions.md §pi.events line 1532. Do not
 *     confuse it with `pi.on`.)
 *
 * REAL EVENT NAMES vs the DESIGN'S GUESS. Verified union `ExtensionEvent`
 * (types.d.ts line 709) + the `pi.on` overloads (types.d.ts 784-812) + the
 * lifecycle diagram (docs/extensions.md 268-335):
 *
 *   WorkerEvent          design GUESS        REAL pi event       verdict
 *   -----------          ------------        -------------       -------
 *   session_start    <-  session_start    <- "session_start"     CORRECT
 *   user_prompt_submit<- input            <- "input"             name ok*
 *   pre_tool_use     <-  tool_call        <- "tool_call"         CORRECT
 *   post_tool_use    <-  tool_result      <- "tool_result"       CORRECT
 *   stop             <-  agent_end        <- "agent_end"         CORRECT
 *   session_end      <-  session_shutdown <- "session_shutdown"  CORRECT
 *
 *   The design's GUESSED NAMES all MATCH the real API: session_start, input,
 *   tool_call, tool_result, agent_end, session_shutdown are every one a real
 *   `pi.on` event name. No divergence — the guess was accurate.
 *
 *   * `input` nuance: `"input"` fires for ALL user input (interactive/rpc/
 *     extension) BEFORE skill/template expansion and can be intercepted
 *     (types.d.ts 567-585, docs 804-850). For a faithful "user submitted a
 *     prompt" signal we likely want `"input"` filtered to
 *     `event.source === "interactive"` (or alternatively `before_agent_start`,
 *     which fires AFTER expansion and carries the final `prompt` string —
 *     types.d.ts 467-478). C2 picks one; both are verified to exist. Using
 *     `"input"` matches the hook semantics (UserPromptSubmit = raw submit).
 *
 *   Recommended pi.on -> WorkerEvent mapping for C2:
 *     pi.on("session_start")    -> { event: "session_start", cwd }
 *     pi.on("input")            -> { event: "user_prompt_submit" }   (filter source)
 *     pi.on("tool_call")        -> { event: "pre_tool_use", tool, tool_input }
 *     pi.on("tool_result")      -> { event: "post_tool_use", tool }
 *     pi.on("agent_end")        -> { event: "stop" }
 *     pi.on("session_shutdown") -> { event: "session_end" }
 *
 * HANDLER PAYLOAD SHAPES (types.d.ts; what's available to build each WorkerEvent):
 *   - SessionStartEvent (382-388): { type, reason, previousSessionFile? }.
 *     NO cwd, NO session id on the event itself — get cwd from `ctx.cwd`
 *     (ExtensionContext.cwd, line 213) and the sid from `ctx.sessionManager`
 *     (see §3). `reason` is "startup"|"reload"|"new"|"resume"|"fork".
 *   - InputEvent (567-575): { type, text, images?, source }. `source` is
 *     "interactive"|"rpc"|"extension".
 *   - ToolCallEvent (586-628): { type:"tool_call", toolCallId, toolName,
 *     input }. `toolName` is "bash"|"read"|"edit"|"write"|"grep"|"find"|"ls"
 *     for built-ins or `string` for custom; `input` is the (mutable) tool args
 *     object -> maps to WorkerEvent `tool` + `tool_input`.
 *   - ToolResultEvent (629-669): { type:"tool_result", toolCallId, toolName,
 *     input, content, isError, details } -> `toolName` maps to `tool`.
 *   - AgentEndEvent (484-487): { type:"agent_end", messages: AgentMessage[] }.
 *     No fields needed for our `stop` event.
 *   - SessionShutdownEvent (416-421): { type, reason, targetSessionFile? }.
 *     `reason` is "quit"|"reload"|"new"|"resume"|"fork" — note shutdown fires
 *     on /new, /resume, /fork, /reload AND quit (docs lifecycle 306-335). For
 *     a TRUE session_end (process exit) C2 may want to gate on reason==="quit"
 *     to avoid emitting session_end on mid-session reloads/switches.
 *
 * ----------------------------------------------------------------------------
 * 3. SESSION ID ACQUISITION + TRANSCRIPT PATH/FORMAT  (VERIFIED)
 * ----------------------------------------------------------------------------
 * SESSION ID: the extension reads it from `ctx.sessionManager`, NOT from any
 * event payload. `ExtensionContext.sessionManager` is a `ReadonlySessionManager`
 * (types.d.ts 215) = Pick<SessionManager, ...> including:
 *     getSessionId(): string          (the session UUID; the header `id`)
 *     getSessionFile(): string|undefined  (absolute transcript JSONL path; undefined if in-memory)
 *     getCwd(): string
 *     getSessionDir(): string
 *   - dist/core/session-manager.d.ts line 136 (`ReadonlySessionManager` Pick)
 *     and lines 188-191. Confirmed by SessionManager API list in
 *     docs/session-format.md 405-412.
 *   Pi is derive-id: the sid is minted by pi, so the extension self-registers
 *   `<sid>.meta` (via our `writeMeta`) on the FIRST event for that sid — exactly
 *   like the codex hook does (src/hooks/emit-event.ts 88-104). The meta should
 *   record `harness:"pi"`, `tmux_name`, `cwd`, `session_id`, and the
 *   `transcript_path` = `getSessionFile()` so `pi.transcriptPath()` (C3) can
 *   read it back from the meta (mirrors src/harness/codex.ts transcriptPath).
 *
 * TRANSCRIPT PATH SCHEME (the data plane parseTurn reads):
 *     ~/.pi/agent/sessions/--<cwd-with-slashes-as-dashes>--/<ts>_<uuid>.jsonl
 *   - docs/session-format.md 5-11: `~/.pi/agent/sessions/--<path>--/<timestamp>
 *     _<uuid>.jsonl`, `<path>` = cwd with `/` replaced by `-`.
 *   - VERIFIED on disk: `~/.pi/agent/sessions/--Users-jesse--/
 *     2026-05-27T22-58-56-901Z_019e6ba9-...jsonl` exists with that exact scheme.
 *   - Configurable via `--session-dir <dir>` flag or `PI_CODING_AGENT_SESSION_DIR`
 *     env (docs/usage.md 177, 263). `getSessionFile()` returns the resolved
 *     absolute path regardless, so C3 should prefer reading it from the meta
 *     over reconstructing the path.
 *
 * TRANSCRIPT RECORD FORMAT (JSONL; for C3's parseTurn) — VERIFIED against a real
 * on-disk session file AND docs/session-format.md:
 *   - Line 1 HEADER: {"type":"session","version":3,"id":"<uuid>","timestamp":
 *     "...","cwd":"<cwd>"[,"parentSession":"..."]}. `id` IS the session id.
 *   - Tree entries (SessionMessageEntry, type:"message"): {"type":"message",
 *     "id":"<8hex>","parentId":"<8hex>|null","timestamp":"ISO","message":{...}}.
 *     The `message` is an `AgentMessage`:
 *       role:"user"      -> content: string | (text|image)[]
 *       role:"assistant" -> content: (text|thinking|toolCall)[]; has
 *                           `stopReason` ("stop"|"length"|"toolUse"|"error"|
 *                           "aborted"), provider, model, usage. A toolCall block
 *                           is {type:"toolCall", id, name, arguments}.
 *       role:"toolResult"-> { toolCallId, toolName, content:(text|image)[],
 *                             details?, isError }.
 *   - Other entry types seen on disk: "model_change", "thinking_level_change";
 *     docs add "compaction", "branch_summary", "custom", "custom_message",
 *     "label", "session_info". (docs/session-format.md 184-291.)
 *   The design's guessed record names (`message:user`, `message:assistant` with
 *   toolUse, `message:toolResult`, stopReason) MAP to: a `message` entry whose
 *   inner `message.role` is user/assistant/toolResult, assistant toolCalls are
 *   `content[].type === "toolCall"` (NOT "toolUse"), and `stopReason` lives on
 *   the assistant message. C3's parseTurn should key on `entry.type==="message"`
 *   + `entry.message.role` + assistant `content[].type==="toolCall"`.
 *
 * ----------------------------------------------------------------------------
 * 4. LAUNCH + AUTH + QUIT  (VERIFIED)
 * ----------------------------------------------------------------------------
 * LAUNCH FLAGS (docs/usage.md §CLI Reference 120-218):
 *   - session dir: `--session-dir <dir>` (overrides `PI_CODING_AGENT_SESSION_DIR`).
 *   - model: `--model <pattern>` (supports `provider/id` and `:<thinking>`);
 *     `--provider <name>` optional. (lines 162-165.)
 *   - extension: `-e <path>` / `--extension <source>` (line 194), repeatable.
 *   - session id: pi MINTS its own; there is NO `--session-id` assign flag (only
 *     `--session <path|id>` to RESUME an existing one, `--fork`, `-c`, `-r`).
 *     This confirms idStrategy:"derive" for the pi driver.
 *   - The design's guessed `pi --session-dir <home>/.csd/sessions --model <route>
 *     -e <ext>` is structurally correct; the real session dir for csd should be
 *     the per-worker home (see auth below) so the worker's sessions/auth/config
 *     are isolated, OR set `PI_CODING_AGENT_DIR` to the per-worker home.
 *
 * AUTH STAGING:
 *   - Pi keeps credentials in `auth.json` UNDER the agent dir:
 *     `getAuthPath()` -> `<agentDir>/auth.json`, agentDir = `getAgentDir()` =
 *     `~/.pi/agent` (env override `PI_CODING_AGENT_DIR` / `ENV_AGENT_DIR`).
 *     dist/config.d.ts lines 66-78 (`getAuthPath`, `getAgentDir`, `ENV_AGENT_DIR`).
 *   - VERIFIED on disk: `~/.pi/agent/auth.json` exists (mode 0600), plus
 *     `models.json`, `settings.json`, `sessions/`, `bin/` in the same dir.
 *   - STAGING PLAN (parity with codex): for a per-worker home, set
 *     `PI_CODING_AGENT_DIR=<workerHome>` in the worker env and copy the
 *     operator's `~/.pi/agent/auth.json` (and likely `models.json`/`settings.json`)
 *     into `<workerHome>/auth.json`, so the worker authenticates as the operator.
 *     (Auth can alternatively be done interactively via `/login` — docs/usage.md
 *     38, 137 — but csd should stage the file, like codex stages `~/.codex/auth.json`.)
 *   - UNVERIFIED: the exact JSON schema of auth.json per provider (on this box
 *     the only top-level key is "openai-codex"); we only need to COPY it, not
 *     parse it, so the schema does not block C2/C3. If C3 must validate a pi
 *     login it should runtime-check `pi --list-models` / a real launch.
 *
 * QUIT: `/quit` (docs/usage.md §Slash Commands line 56: "`/quit` Quit pi").
 *   There is no `/exit` alias documented. (Ctrl+C/Ctrl+D/SIGHUP/SIGTERM also
 *   trigger session_shutdown per the lifecycle diagram, docs 333-335, but the
 *   driver's `quitKeys` analogue is the typed command `/quit`.)
 *
 * ----------------------------------------------------------------------------
 * tsup.config.ts NOTE: left AS-IS in C1 (still CJS `.cjs` for all 3 entries).
 * The pi-extension entry MUST become ESM `dist/pi-extension.mjs` for pi's
 * jiti/ESM loader, but flipping it now (with the file still a `export {}` stub)
 * would churn `dist/` and `dist:check` without the real extension behind it.
 * C2 implements the extension and performs the format flip + dist rebuild as one
 * coherent change. Decision RECORDED here; not half-applied (per the task's
 * "prefer recording over a risky half-change").
 * ----------------------------------------------------------------------------
 */

import { existsSync } from 'node:fs';
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { appendEvent } from '../core/event-log.js';
import { eventsPath, metaPath } from '../core/paths.js';
import { isoSecondsUtc } from '../core/time.js';
import { writeMeta } from '../core/worker-store.js';
import type { WorkerEvent } from '../events.js';

/**
 * ============================================================================
 * C2 — the csd worker control plane for Pi, as a native extension.
 * ============================================================================
 *
 * ENV CONTRACT (set by the pi driver, C3, in the worker's tmux env via `-e`):
 *   - CSD_WORKER_DIR — where `<sid>.events.jsonl` + `<sid>.meta` are written.
 *     If UNSET the extension no-ops every handler (it is not a managed worker),
 *     so a user running plain `pi -e <ext>` outside csd records nothing.
 *   - CSD_TMUX_NAME — the tmux window name baked into the self-registered meta
 *     so the controller can resolve the worker by name. Empty if unset.
 *
 * SELF-REGISTRATION: pi mints its own session id (derive strategy), so csd
 * cannot pre-write `<sid>.meta` at launch. On the FIRST recorded event for a
 * sid the extension writes the meta — `{ tmux_name, session_id, cwd, harness:
 * 'pi', transcript_path }` — mirroring the codex hook (src/hooks/emit-event.ts).
 * It never overwrites an existing meta.
 *
 * BEST-EFFORT / NEVER THROW: every handler swallows its own errors. A throw out
 * of a pi handler could destabilize pi (same rationale as the hooks no-op on bad
 * input). Recording a worker's activity must never crash the worker.
 */

/** Read the worker dir from the env, or null when this is not a managed worker. */
function workerDirFromEnv(): string | null {
  const dir = process.env.CSD_WORKER_DIR;
  return dir !== undefined && dir.length > 0 ? dir : null;
}

/**
 * Self-register `<sid>.meta` if it does not already exist, then append `e` to
 * `<sid>.events.jsonl`. No-ops (returns) when CSD_WORKER_DIR is unset. All work
 * is wrapped so a failure here never escapes into pi.
 */
function record(ctx: ExtensionContext, e: WorkerEvent): void {
  try {
    const dir = workerDirFromEnv();
    if (dir === null) return;

    const sid = ctx.sessionManager.getSessionId();
    if (sid.length === 0) return;

    if (!existsSync(metaPath(dir, sid))) {
      const transcriptPath = ctx.sessionManager.getSessionFile();
      writeMeta(dir, {
        tmux_name: process.env.CSD_TMUX_NAME ?? '',
        session_id: sid,
        cwd: ctx.cwd,
        harness: 'pi',
        ...(transcriptPath !== undefined && transcriptPath.length > 0
          ? { transcript_path: transcriptPath }
          : {}),
      });
    }

    appendEvent(eventsPath(dir, sid), e);
  } catch {
    // Best-effort recording: never throw out of a pi handler.
  }
}

/**
 * Default factory pi calls with the ExtensionAPI. Registers the six lifecycle
 * handlers that map pi events to our WorkerEvent vocabulary. Synchronous: there
 * is no async setup, so pi has nothing to await before `session_start`.
 */
export default function csdPiExtension(pi: ExtensionAPI): void {
  pi.on('session_start', (_event: SessionStartEvent, ctx) => {
    record(ctx, { event: 'session_start', ts: isoSecondsUtc(), cwd: ctx.cwd });
  });

  pi.on('input', (event: InputEvent, ctx) => {
    // Only a real interactive submit is a "user prompt"; rpc/extension-sourced
    // input is machinery, not the operator typing.
    if (event.source !== 'interactive') return;
    record(ctx, { event: 'user_prompt_submit', ts: isoSecondsUtc() });
  });

  pi.on('tool_call', (event: ToolCallEvent, ctx) => {
    record(ctx, {
      event: 'pre_tool_use',
      ts: isoSecondsUtc(),
      tool: event.toolName,
      tool_input: event.input,
    });
  });

  pi.on('tool_result', (event: ToolResultEvent, ctx) => {
    record(ctx, {
      event: 'post_tool_use',
      ts: isoSecondsUtc(),
      tool: event.toolName,
    });
  });

  pi.on('agent_end', (_event: AgentEndEvent, ctx) => {
    record(ctx, { event: 'stop', ts: isoSecondsUtc() });
  });

  pi.on('session_shutdown', (event: SessionShutdownEvent, ctx) => {
    // Shutdown also fires on /new, /resume, /fork, /reload — only `quit` is a
    // true process-exit session_end.
    if (event.reason !== 'quit') return;
    record(ctx, { event: 'session_end', ts: isoSecondsUtc() });
  });
}
