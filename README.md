# claude-session-driver

Turn one Claude Code session into a project manager that delegates tasks to other Claude Code sessions.

## Why

A single Claude session works on one task at a time. With this plugin, a controller session launches worker sessions in tmux, assigns each a task, monitors their progress, and collects results. Workers run in parallel. The controller decides what to do with their output.

## How It Works

Workers run with `--dangerously-skip-permissions` and execute tool calls without prompting. The plugin's hooks write lifecycle events to a JSONL file — session start, prompt submitted, each tool call (with name and input), stop, and session end — so a controller can watch what each worker is doing. The events are observation-only; the plugin does not gate tool calls.

The controller orchestrates workers through a single CLI (`csd`) that manages tmux sessions, polls events, reads conversation logs, and cleans up.

## Installation

```bash
claude plugin install claude-session-driver@superpowers-marketplace
```

If your marketplace cache predates this plugin, update it first:

```bash
claude plugin marketplace update superpowers-marketplace
```

Requires **tmux**, **jq**, and the **claude** CLI.

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

### Skill-path subcommands

| Subcommand | Purpose |
|------------|---------|
| `csd launch <name> <cwd> [-- claude-args...]` | Bootstrap a worker; prints a shim path to stdout |
| `csd list [--all]` | List active (or all) workers |
| `csd grant-consent` | One-time consent flow (required before first launch) |

`csd launch` prints the shim path to stdout and a human-readable panel to stderr. Capture it:

```bash
WORKER=$(csd launch my-worker /path/to/project)
```

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
| `$WORKER session-id` | Print the session UUID |
| `$WORKER events-file` | Print the path to the JSONL event file |

### Design docs

- `docs/superpowers/specs/` — design specifications
- `docs/superpowers/plans/` — implementation plans

## License

MIT
