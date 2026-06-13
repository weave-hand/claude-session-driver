# TS-Core Rewrite — Design Spec

- **Date:** 2026-06-13
- **Status:** Approved (Jesse, 2026-06-13)
- **Branch:** `ts-core`
- **Supersedes (as implementation, not as knowledge):** PR #21 "feat: drive Codex and Pi workers alongside Claude" (mined as reference; not merged)

## 1. Context & motivation

`claude-session-driver` (`csd`) drives worker Claude Code / Codex / Pi sessions running in
tmux: launch them, send prompts, read their event stream and transcripts, stop them. The
shipped implementation (v3.0.2) is ~1006 lines of bash in a single `csd` spine plus a
53-line `_lib.sh`, a bash+jq `emit-event` hook, and 18 bash test files.

The multi-harness work (PR #21) pushed bash past where it pays off. The original `csd` was a
sweet spot for shell — thin glue over tmux, file tails, and process spawns. But adding Codex
and Pi turned the tool into a **data-transformation engine**: it now parses three
heterogeneous JSONL transcript formats and normalizes them to a common event/turn model.
That is exactly where bash+jq costs more than it saves. The concrete evidence: every bug
found reviewing PR #21 was a *shell-idiom* bug, not a logic bug —

- a new event type (`post_tool_use`) added to the vocabulary and emitted by Codex/Pi but not
  threaded through the `_worker_status` classifier (a stringly-typed-schema gap);
- `$cwd` interpolated unquoted into a shell-evaluated Codex config command string
  (a quoting/injection gap), with the test fixture sharing the same flaw.

Three independent forces point off-shell: those bug classes; issue #15 (Windows: bash/jq are
not on Claude Code's hook PATH) wants the hooks rewritten in a portable language; and Pi's
native extension API is TypeScript. The hooks need porting regardless.

**Decision:** rebuild the core in TypeScript. A typed event union makes the
half-threaded-schema bug a compile error; argv-array process spawns make the quoting bug
structurally impossible; real JSON parsing removes jq entirely; and `node`-based hooks fix
#15 by construction. Language: **TypeScript, not Python** — Node is already guaranteed
present wherever Claude Code runs (Claude Code is a Node app), so it adds no runtime
dependency, and it aligns with Pi's TS extension model. Python would reintroduce the very
"runtime not guaranteed on Windows" problem #15 is about.

## 2. Goals & non-goals

### Goals
- **Full behavioral parity** with the v3.0.2 `csd` CLI — every subcommand, flag, output
  shape, env var, and side effect (see §3).
- The multi-harness surface done correctly: **Claude, Codex, and Pi** workers.
- Typed event model + driver interface that make the PR #21 bug classes impossible.
- Portable hooks (`node`), closing issue #15.
- Committed `dist/` so the plugin needs no build step on a user's machine.

### Non-goals (explicitly out of scope for this effort)
- **Remote SSH/Docker workers** (issue #4 / PR #6). Separate effort.
- **tmux namespace inheritance** (PR #8). Separate effort.
- Any new user-facing feature beyond what v3.0.2 + the Codex/Pi harnesses already imply.

## 3. Parity target — the v3.0.2 surface that must be reproduced

### CLI surface
Top-level subcommands (no `--worker`):
- `launch <tmux-name> <cwd> [-- harness-args...]` — bootstrap a worker; prints shim path on
  stdout, status panel on stderr. **Adds** `--harness <claude|codex|pi>` (default `claude`).
- `adopt <tmux-name> <cwd> <session-id> [-- claude-args...]` — re-adopt an existing Claude
  session via `claude --resume`; respawns an existing tmux pane in place or opens a new one.
  **Claude-only** (Codex/Pi mint their own ids; adopt stays Claude-only, matching PR #21).
- `list [--all] [<pattern>]` — enumerate workers; default skips `gone` workers; pattern is a
  tmux-name substring filter.
- `grant-consent` — one-time consent for `--dangerously-skip-permissions`.
- `help` — usage.

Per-worker subcommands (require `--worker <name>`, supplied by the shim):
- `converse [--with-turn] <prompt> [timeout=120]` — send, wait for turn, return assistant
  text (or full markdown turn with `--with-turn`).
- `send <prompt>` — send a prompt without waiting; confirms submission (issue #20).
- `wait-for-turn [timeout=60]` — block until the next `stop` OR `session_end`.
- `status` — `idle | working | terminated | gone | unknown`.
- `read-events [--last N] [--type T] [--follow]` — read the event JSONL stream.
- `read-turn [--full]` — last turn as markdown; tool results truncated to 5 lines unless
  `--full`.
- `stop` — quit the harness, clean up meta + events + shim.
- `handoff` — print tmux-attach instructions for a human.
- `session-id` — print the worker's session UUID.
- `events-file` — print the absolute path to the events JSONL.

Top-level vs per-worker validation: `--worker` is rejected for top-level subs and required
for per-worker subs (same error semantics as today).

### Subsystems (behaviors to preserve)
- **Launch:** tmux `new-session` running the harness; for Claude, the controller assigns
  `--session-id`; workspace-trust / bypass-permissions dialog handling; await `session_start`
  as proof of life; **scrub stale provider/auth env** so workers don't inherit an expired
  Bedrock/Vertex/host-brokered provider (issue #18, commit 5e4af5c); write a deterministic
  per-worker shim; back-compat symlink.
- **Adopt:** `claude --resume <sid>`; `respawn-pane -k` when the tmux session already exists
  (e.g. tmux-resurrect), else `new-session`.
- **Event stream:** append-only JSONL at `<worker_dir>/<sid>.events.jsonl`, written by the
  hook (Claude/Codex) or extension (Pi); `status` classifies the last event.
- **Transcript → markdown:** `read-turn` locates the harness transcript, finds the last user
  prompt, and renders assistant/user turns to markdown (thinking as blockquote, text,
  tool-use as fenced JSON, tool-result with 5-line truncation, tool errors). Skips
  `<local-command…>` / `<command-name…>` synthetic user lines.
- **Send / converse:** `tmux send-keys` the prompt; confirm the prompt was actually
  submitted via the `user_prompt_submit` event before waiting (issue #20); wait for the turn;
  render. On timeout, optional post-mortem diagnostic when `CSD_CONVERSE_DIAG_FILE` is set
  (ps tree + `capture-pane` + transcript tail + events tail).
- **Consent:** one-time consent file gating `--dangerously-skip-permissions`.
- **State & paths:** `.meta` (`tmux_name`, `session_id`, `cwd`, `harness`, …) and a shim at
  `<worker_dir>/bin/<tmux-name>`.

### Paths & env
- Worker dir: **`/tmp/csd-workers`** (the harness-agnostic name, per PR #21), overridable via
  `CSD_WORKER_DIR`. A back-compat symlink `/tmp/claude-workers → /tmp/csd-workers` is created
  when the default path is in use and the old path doesn't already exist.
- Claude transcript: `$HOME/.claude/projects/<cwd-with-slashes-as-dashes>/<sid>.jsonl`.
- Env vars preserved: `CSD_CLAUDE_BIN` (and `CSD_CODEX_BIN`, `CSD_PI_BIN`),
  `CSD_CONVERSE_DIAG_FILE`, `CSD_WORKER_DIR`, `HOME`.

## 4. Architecture

The single spine decomposes into focused modules, each with one purpose and a clear
interface, small enough to hold in context and unit-test in isolation.

```
src/
  cli.ts                  arg parse, --worker handling, dispatch
  commands/
    launch.ts adopt.ts list.ts grant-consent.ts
    converse.ts send.ts wait-for-turn.ts status.ts
    read-events.ts read-turn.ts stop.ts handoff.ts
    session-id.ts events-file.ts
  core/
    paths.ts              worker dir, transcript path, encoded-cwd, symlink
    worker-store.ts       .meta read/write, shim write/remove, enumerate
    tmux.ts               execFile('tmux', [...]) wrappers (new-session, send-keys,
                          capture-pane, has-session, kill-session, respawn-pane)
    event-log.ts          append/read/tail JSONL; workerStatus() exhaustive classifier
    transcript.ts         normalized turn model + shared markdown renderer
    consent.ts            consent file gate
    proc.ts               execFile helpers (no shell; argv arrays)
    diagnostics.ts        converse post-mortem
  events.ts               WorkerEvent discriminated union + (de)serialize + validate
  harness/
    driver.ts             HarnessDriver interface + registry/loader
    claude.ts codex.ts pi.ts
  hooks/
    emit-event.ts         node hook for Claude AND Codex (reads stdin JSON, appends event)
  pi-extension/
    index.ts              pi native TS extension (pi.on(...) -> append event)
dist/                     COMMITTED tsup bundles: csd.cjs, emit-event.cjs, pi-extension.mjs
tests/                    vitest unit tests + integration tests + fixtures/
```

**Plugin invocation points** change to exec node on the bundles:
- `skills/driving-claude-code-sessions/scripts/csd` becomes a one-line shim:
  `exec node "${CLAUDE_PLUGIN_ROOT}/dist/csd.cjs" "$@"` (kept at the same path so SKILL.md and
  the user contract are stable).
- `hooks/hooks.json` calls `node "${CLAUDE_PLUGIN_ROOT}/dist/emit-event.cjs"` directly. The
  bash `emit-event` and the `run-hook.cmd` polyglot wrapper are **removed** — node is
  cross-platform, which is the fix for #15.

All subprocess interaction uses `execFile(cmd, [args])` (argv arrays, no shell), so no
user/worker-controlled string is ever concatenated into a shell command. This eliminates the
quoting/injection class structurally.

## 5. Typed event model (the load-bearing contract)

```ts
type WorkerEvent =
  | { event: 'session_start';      ts: string; cwd?: string }
  | { event: 'user_prompt_submit'; ts: string }
  | { event: 'pre_tool_use';       ts: string; tool: string; tool_input: unknown }
  | { event: 'post_tool_use';      ts: string; tool: string }
  | { event: 'stop';               ts: string }
  | { event: 'session_end';        ts: string };
```

`workerStatus(lastEvent)` is an **exhaustive `switch` with a `never`-typed default**, so
adding a variant without handling it everywhere fails `tsc`. The exact PR #21 bug
(`post_tool_use` unhandled) cannot recur. `post_tool_use` is in the union from day one
(Claude never emits it; Codex/Pi do).

Status mapping (parity): `session_end → terminated`; `user_prompt_submit | pre_tool_use |
post_tool_use → working`; `stop | session_start → idle`; no tmux session → `gone`; no events
file → `unknown`.

## 6. Driver interface

```ts
interface HarnessDriver {
  id: 'claude' | 'codex' | 'pi';
  controlPlane: 'hooks' | 'extension';   // how events reach the JSONL sink
  idStrategy: 'assign' | 'derive';        // controller assigns id vs harness mints it
  quitKeys: string;                       // e.g. '/exit', '/quit'
  bin(): string;
  launchArgv(mode, sessionId, cwd, pluginDir, workerHome): string[];
  prepare(tmuxName, cwd, workerHome): Promise<void>;     // e.g. write CODEX_HOME config
  postLaunch(tmuxName): Promise<void>;                   // dismiss trust gate, etc.
  awaitReady(tmuxName, sessionId): Promise<void>;
  transcriptPath(sessionId, cwd, workerHome): string;
  parseTurn(transcript): NormalizedTurn;                 // harness-specific parse only
}
```

The compiler enforces that every driver implements every member — the PR's unenforceable
"sourced shell slots" become a checked interface. Drivers return a **normalized turn model**;
markdown rendering lives **once** in `core/transcript.ts`, not re-implemented per harness.

## 7. Harness integrations

- **Claude** (`controlPlane: 'hooks'`, `idStrategy: 'assign'`): `hooks.json` registers the
  node `emit-event.cjs` on SessionStart/UserPromptSubmit/PreToolUse/Stop/SessionEnd. The hook
  reads the hook JSON on stdin, no-ops unless `<sid>.meta` exists, maps the event name, and
  appends a normalized `WorkerEvent`. Behavioral parity with today's bash hook, minus jq.
- **Codex** (`controlPlane: 'hooks'`, `idStrategy: 'derive'`): `prepare()` writes a per-worker
  `CODEX_HOME/config.toml` (model, project trust, and the same `emit-event.cjs` hook for each
  lifecycle event). The config is produced by a **real serializer**, so paths with spaces are
  safe (the PR's `$cwd` bug cannot recur). Carries over the PR's validated behaviors: the
  trust-gate dismissal in `postLaunch()`, and the **derive-id pre-registration window** — on
  first `send`, target tmux by name, poll for the self-registered `<sid>.meta`, then proceed.
  The hook self-registers `<sid>.meta` from the SessionStart payload.
- **Pi** (`controlPlane: 'extension'`, `idStrategy: 'derive'`): a **native TS extension**
  (`pi.on('session_start'|'input'|'tool_call'|'tool_result'|'agent_end'|'session_shutdown',
  …)`) that maps each pi event to a `WorkerEvent` and **appends it directly to the same
  `<sid>.events.jsonl` sink** the hooks write. This **retires the poller** from PR #21 and its
  false "pi has no hooks" premise, removes the long-running second process, and gives a single
  event-ingestion path. The extension imports `events.ts` for a shared type source of truth.
  `prepare()` stages the operator's pi auth into the per-worker home and registers the
  extension (`pi -e <bundle>` or install into the per-worker `.pi/extensions/`). Pi still
  mints its own id; the extension self-registers `<sid>.meta` on first event, reusing the same
  pre-registration-window path as Codex.

Pi event mapping: `session_start → session_start`; `input → user_prompt_submit`;
`tool_call → pre_tool_use`; `tool_result → post_tool_use`; `agent_end → stop`;
`session_shutdown → session_end`. (Implementation verifies pi 0.74.0's accepted extension
formats — `.ts` vs `.mjs` — against the installed binary and ships the right bundle target or
a tiny `.ts` shim importing the bundle.)

## 8. Build & tooling

Adapted from `prime-radiant-inc/brainstorm` (the lint/format/typecheck/hooks setup transfers;
its Vite/React-Router build pipeline does not, so we add a bundler).

- **Package manager:** pnpm 10.32.1 (`packageManager` pinned), `type: module`, Node 22
  (`.nvmrc` = `22`, `engines.node >= 22.12.0`).
- **Lint/format:** Biome 2.4.15 with brainstorm's rule escalations — `noUnusedVariables`,
  `noUnusedImports`, `noUnusedFunctionParameters`, `useConst`, `noExplicitAny` = error;
  `noNonNullAssertion` = warn; formatter 2-space, single quotes, always semicolons. `includes`
  scoped to `src/**` and `tests/**` (drop brainstorm's app/server/drizzle paths); a test
  override relaxes `noExplicitAny`/`noNonNullAssertion`/unused rules in `tests/**`.
- **Typecheck:** `tsc --noEmit` with brainstorm's strict flags — `strict`,
  `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`, `moduleResolution: bundler`,
  `isolatedModules`, `skipLibCheck`, `forceConsistentCasingInFileNames`, `esModuleInterop`,
  `resolveJsonModule`, `target/module: ES2022`.
- **Bundler:** **tsup** (esbuild-based) compiles `src` entry points to committed `dist`:
  `cli.ts → dist/csd.cjs`, `hooks/emit-event.ts → dist/emit-event.cjs` (CJS, simple node
  exec), `pi-extension/index.ts → dist/pi-extension.mjs` (ESM, for pi's loader). Bundles are
  self-contained (no `node_modules` needed at runtime on the user's machine).
- **Tests:** vitest.
- **Git hooks:** lefthook — pre-commit runs Biome (`biome check`, `stage_fixed`) + `tsc
  --noEmit`; pre-push runs `pnpm build` + `pnpm vitest run`.
- **Committed-dist freshness guard:** because `dist/` is committed, a pre-push step and CI
  step run `pnpm build && git diff --exit-code dist/` so source and bundles never drift.
- **CI:** GitHub Actions — install pnpm via corepack, `pnpm install --frozen-lockfile`,
  typecheck, build, `vitest run`, dist-freshness check.

`scripts` (package.json): `build` (tsup), `lint` (`biome check .`), `lint:fix`, `typecheck`
(`tsc --noEmit`), `test` (`vitest`), `prepare` (`lefthook install || true`).

## 9. Test strategy

- **Unit (vitest, no tmux):** the previously bug-prone, now-pure logic — event
  classification/serialization, per-harness transcript parsing, shared turn rendering, Codex
  config generation (incl. spaced-path quoting), pre-registration resolution, arg parsing.
  These are fast and cover exactly what kept breaking.
- **Integration (real tmux + fake harness fixtures):** keep the language-agnostic
  `fake-claude` / `fake-codex` / `fake-pi` test-double pattern (invoked via `CSD_*_BIN`)
  driving real tmux through the full launch → send → read-turn → stop flow. Port the coverage
  of the existing 18 bash test files. Fixtures must faithfully model how the real harness
  invokes the hook (e.g. shell-evaluating the Codex command string), so quoting bugs surface
  in tests.
- **Gate:** the full suite (unit + integration) green on each phase boundary; lint + typecheck
  clean; `dist/` rebuilt and committed.

## 10. Staging plan

Four phases, each independently green (tests + lint + typecheck + fresh dist):

- **(a) Claude-only core at parity.** Tooling scaffold (pnpm/Biome/tsconfig/tsup/vitest/
  lefthook/CI), the typed event model, driver interface, Claude driver, node hook, all
  subcommands, the shim/hooks.json wiring. Behavioral parity with v3.0.2 verified by the
  ported integration suite.
- **(b) Codex driver.** Node hook reuse, `CODEX_HOME` config generation (real serializer),
  trust-gate dismissal, derive-id pre-registration window, Codex transcript parsing,
  `--harness codex`.
- **(c) Pi driver.** Native TS extension writing to the JSONL sink, pi auth staging, pi
  transcript parsing, `--harness pi`. Retires any poller concept.
- **(d) Docs & closeout.** Update `SKILL.md` and `README.md` to the `--harness` surface;
  remove the dead bash hook + `run-hook.cmd`; close issue #15; note Codex/Pi requirements.

## 11. PR #21 / mhat

PR #21 is **mined as the reference spec** — the validated Codex trust-gate dance, the
derive-id pre-registration flow, the pi stopReason→event mapping, "validated against codex
0.134" — and is **not merged** (it would add shell we're deleting). The branch is kept as the
source of truth for those integration details. Loop mhat in on the direction rather than
silently closing 31 commits; his design knowledge ports directly, only the language changes.

## 12. Risks & open verifications

- **Pi extension format** (`.ts` vs compiled `.mjs`) and exact `pi.on` event names are
  verified against the installed pi 0.74.0 during phase (c); the design's mapping is from the
  shipped pi docs/types but the bundle target may need a `.ts` shim.
- **Trust-gate / dialog timing** for Codex (and Claude bypass-permissions) is timing-sensitive
  in tmux; the fixtures must reproduce the dialog text so the dismissal logic is tested, not
  just the happy path.
- **Committed dist drift** is guarded by the freshness check; contributors must `pnpm build`
  before pushing (enforced by lefthook pre-push + CI).
