# claude-session-driver

Turn one coding-agent session into a project manager that delegates tasks to other coding-agent sessions — Claude Code, Codex, or Pi.

## Why

A single coding-agent session works on one task at a time. With this plugin, a controller session launches worker sessions in tmux, assigns each a task, monitors their progress, and collects results. Workers run in parallel. The controller decides what to do with their output.

## How It Works

Workers run with permissions bypassed and execute tool calls without prompting. Each worker writes lifecycle events to a JSONL file — session start, prompt submitted, each tool call (with name and input), stop, and session end — so a controller can watch what each worker is doing. The events are observation-only; the plugin does not gate tool calls.

The controller drives three harnesses through one CLI (`csd`), chosen at launch with `--harness <claude|codex|pi>` (default `claude`):

- **Claude Code** and **Codex** emit events through their hook systems (node hook programs).
- **Pi** emits events through a native TypeScript extension `csd` loads into it.

Whichever harness you launch, the controller-facing command surface is **identical** — `launch`, `send`, `converse`, `wait-for-turn`, `read-turn`, `read-events`, `status`, `stop`, and `handoff` all behave the same. (`adopt` is the one exception: it's Claude-only, since Codex and Pi mint their own session ids and offer no resume-by-id.) The CLI manages tmux sessions, polls events, reads conversation logs, and cleans up.

## Installation

```bash
claude plugin install claude-session-driver@superpowers-marketplace
```

If your marketplace cache predates this plugin, update it first:

```bash
claude plugin marketplace update superpowers-marketplace
```

Requires **tmux** and a harness CLI — at least the one you launch: **claude** (default), **codex**, or **pi**. No `jq` and no bash hooks: `csd` is a TypeScript/node tool whose hooks are node programs (`node` is required, but it ships wherever Claude Code runs). Codex stages the operator's `~/.codex` auth into each worker; Pi stages `~/.pi/agent`.

## Usage

Install the plugin and ask Claude to manage a project. The `driving-claude-code-sessions` skill provides orchestration patterns:

- **Delegate and wait:** Launch a worker, assign a task, read the result.
- **Fan out:** Launch several workers on independent tasks, wait for all to finish.
- **Pipeline:** Chain workers so each builds on the previous worker's output.
- **Supervise:** Hold a multi-turn conversation with a worker, reviewing each response.
- **Hand off:** Pass a running worker session to a human operator in tmux.

See `skills/driving-claude-code-sessions/SKILL.md` for detailed usage patterns.

## CLI

All operations go through a single binary at `skills/driving-claude-code-sessions/scripts/csd`.

### Top-level subcommands

| Subcommand | Purpose |
|------------|---------|
| `csd launch [--harness <claude\|codex\|pi>] <name> <cwd> [-- harness-args...]` | Bootstrap a worker (harness defaults to `claude`); prints a shim path to stdout |
| `csd adopt <name> <cwd> <session-id> [-- claude-args...]` | Re-adopt an existing Claude session as a worker (claude-only) |
| `csd list [--all]` | List active (or all) workers |
| `csd grant-consent` | One-time consent flow (required before first launch) |

`csd launch` prints the shim path to stdout (deterministic at `/tmp/csd-workers/bin/<name>`) and a human-readable panel to stderr. Capture it:

```bash
WORKER=$(csd launch my-worker /path/to/project)
```

The worker dir defaults to `/tmp/csd-workers` (renamed from `/tmp/claude-workers`; a back-compat symlink `/tmp/claude-workers → /tmp/csd-workers` is created when the default is in use). Override it with `CSD_WORKER_DIR`.

### Per-worker subcommands

Once you have a shim path, invoke it directly or use `csd --worker <name> <sub>`:

| Subcommand | Purpose |
|------------|---------|
| `$WORKER converse [--with-turn] <prompt> [timeout]` | Send a prompt, wait, return the response |
| `$WORKER send <prompt>` | Send a prompt without waiting |
| `$WORKER wait-for-turn [timeout]` | Block until the worker finishes a turn |
| `$WORKER read-turn [--full]` | Format the last turn as markdown |
| `$WORKER read-events [--last N] [--type T] [--follow]` | Read and filter the event stream |
| `$WORKER status` | Print worker status (idle/working/terminated/gone) |
| `$WORKER stop` | Stop the worker and clean up |
| `$WORKER handoff` | Print tmux attach instructions for a human takeover |
| `$WORKER session-id` | Print the worker's session id |
| `$WORKER events-file` | Print the path to the JSONL event file |

### Environment variables

All optional. `csd help` shows the full list.

| Variable | Purpose |
|----------|---------|
| `CSD_CLAUDE_BIN` / `CSD_CODEX_BIN` / `CSD_PI_BIN` | Path to each harness binary (defaults `claude` / `codex` / `pi`, resolved via `PATH`) |
| `CSD_CODEX_MODEL` / `CSD_PI_MODEL` | Optional model override for codex / pi workers (unset = the harness default) |
| `CSD_WORKER_DIR` | Override the worker dir (default `/tmp/csd-workers`) |
| `CSD_CONVERSE_DIAG_FILE` | When set, `csd converse` writes a post-mortem diagnostic to this path on timeout |

### Design docs

- `docs/superpowers/specs/` — design specifications
- `docs/superpowers/plans/` — implementation plans

## License

MIT
