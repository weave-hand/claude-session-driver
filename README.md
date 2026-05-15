# claude-session-driver

Turn one Claude Code session into a project manager that delegates tasks to other Claude Code sessions.

## Why

A single Claude session works on one task at a time. With this plugin, a controller session launches worker sessions in tmux, assigns each a task, monitors their progress, and collects results. Workers run in parallel. The controller decides what to do with their output.

## How It Works

Workers run with `--dangerously-skip-permissions` and execute tool calls without prompting. The plugin's hooks write lifecycle events to a JSONL file — session start, prompt submitted, each tool call (with name and input), stop, and session end — so a controller can watch what each worker is doing. The events are observation-only; the plugin does not gate tool calls.

The controller orchestrates workers through shell scripts that manage tmux sessions, poll events, read conversation logs, and clean up.

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

## Scripts

| Script | Purpose |
|--------|---------|
| `launch-worker.sh` | Start a worker session in tmux |
| `converse.sh` | Send a prompt, wait, return the response |
| `send-prompt.sh` | Send a prompt without waiting |
| `wait-for-event.sh` | Block until a lifecycle event appears |
| `read-events.sh` | Read and filter the event stream |
| `read-turn.sh` | Format the last turn as markdown |
| `stop-worker.sh` | Stop a worker and clean up |

## License

MIT
