# csd CLI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 13 scripts under `skills/driving-claude-code-sessions/scripts/` with a single `csd` CLI plus per-worker shim files at `/tmp/claude-workers/bin/<tmux-name>`. The shim bakes in the worker handle and the absolute skill path so subsequent calls require no remembered state.

**Architecture:** Single bash file (`scripts/csd`) that self-locates via `BASH_SOURCE[0]`, sources the existing `_lib.sh`, and dispatches to subcommand functions. Top-level subcommands (`launch`, `list`, `grant-consent`) require the skill path. Per-worker subcommands take `--worker <name>` as a top-level flag, supplied implicitly by the shim. `csd launch` writes the shim file with the absolute csd path baked in and prints the shim path to stdout (one line), with a "Worker launched" panel on stderr including a `reproduce:` line that names the exact relaunch command.

**Tech Stack:** Bash, jq, tmux. No new dependencies. Existing `hooks/emit-event` and `hooks/hooks.json` are untouched. Existing `_lib.sh` (resolve_session, validate_event_type, _CSD_VALID_EVENTS) is sourced as-is — no changes required.

**File structure:**

- Create: `skills/driving-claude-code-sessions/scripts/csd` — the single CLI
- Keep: `skills/driving-claude-code-sessions/scripts/_lib.sh` — sourced by csd
- Delete (at end): `launch-worker.sh`, `converse.sh`, `send-prompt.sh`, `wait-for-event.sh`, `read-events.sh`, `read-turn.sh`, `status.sh`, `stop-worker.sh`, `handoff.sh`, `list-workers.sh`, `current.sh`, `grant-consent.sh`
- Rewrite: `skills/driving-claude-code-sessions/SKILL.md`
- New tests: `tests/test-csd-*.sh` (one file per subcommand group)
- Delete (at end): existing `tests/test-{launch-worker,send-prompt,wait-for-event,read-events,integration}.sh`
- Keep: `tests/test-emit-event.sh` (tests the hook, independent of the CLI)
- Update: `CHANGELOG.md`

**Reference spec:** `docs/superpowers/specs/2026-05-18-csd-cli-redesign-design.md`

---

## Task 1: csd skeleton — argument parsing and subcommand dispatch

**Files:**
- Create: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-skeleton.sh`

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-skeleton.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# --- Test 1: csd with no args prints usage and exits non-zero ---
echo "Test 1: csd with no args prints usage"
EXIT_CODE=0
OUTPUT=$(bash "$CSD" 2>&1) || EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  pass "exits non-zero with no args"
else
  fail "exit code" "expected non-zero, got 0"
fi
if echo "$OUTPUT" | grep -q "Usage:"; then
  pass "prints Usage line"
else
  fail "usage line" "expected 'Usage:' in output, got: $OUTPUT"
fi

# --- Test 2: csd help lists every documented subcommand ---
echo "Test 2: csd help lists all subcommands"
OUTPUT=$(bash "$CSD" help 2>&1 || true)
for sub in launch list grant-consent converse send wait-for-turn status \
           read-events read-turn stop handoff session-id events-file; do
  if echo "$OUTPUT" | grep -qw "$sub"; then
    pass "help mentions $sub"
  else
    fail "help missing $sub" "$sub not in help output"
  fi
done

# --- Test 3: unknown subcommand errors clearly ---
echo "Test 3: unknown subcommand fails with message"
EXIT_CODE=0
OUTPUT=$(bash "$CSD" frobnicate 2>&1) || EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ] && echo "$OUTPUT" | grep -qi "unknown"; then
  pass "rejects unknown subcommand"
else
  fail "unknown subcommand" "expected non-zero + error message"
fi

# --- Test 4: top-level subcommands reject --worker ---
echo "Test 4: --worker rejected on top-level subcommands"
for sub in launch list grant-consent; do
  EXIT_CODE=0
  OUTPUT=$(bash "$CSD" --worker foo "$sub" 2>&1) || EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ] && echo "$OUTPUT" | grep -qi "worker"; then
    pass "$sub rejects --worker"
  else
    fail "$sub" "expected --worker rejection"
  fi
done

# --- Test 5: per-worker subcommands require --worker ---
echo "Test 5: per-worker subcommands require --worker"
for sub in status session-id events-file send wait-for-turn read-events \
           read-turn converse stop handoff; do
  EXIT_CODE=0
  OUTPUT=$(bash "$CSD" "$sub" 2>&1) || EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ] && echo "$OUTPUT" | grep -qi "worker"; then
    pass "$sub requires --worker"
  else
    fail "$sub" "expected --worker required error"
  fi
done

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-skeleton.sh`
Expected: FAIL — `scripts/csd` does not exist yet.

- [ ] **Step 3: Implement the skeleton**

Create `skills/driving-claude-code-sessions/scripts/csd`:

```bash
#!/bin/bash
set -euo pipefail

# csd — single CLI for claude-session-driver. Dispatches to subcommand
# functions defined below. Sources _lib.sh for shared helpers.
#
# Top-level subcommands (no --worker): launch, list, grant-consent
# Per-worker subcommands (require --worker): converse, send, wait-for-turn,
#   status, read-events, read-turn, stop, handoff, session-id, events-file
#
# Per-worker subcommands are normally invoked through a shim at
# /tmp/claude-workers/bin/<tmux-name> that bakes in --worker. Direct
# invocation as `csd --worker <name> <sub>` is also supported.

CSD_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$CSD_PATH")"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Parse --worker (top-level flag, before subcommand)
WORKER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worker) WORKER="$2"; shift 2 ;;
    --worker=*) WORKER="${1#--worker=}"; shift ;;
    *) break ;;
  esac
done

SUB="${1:-}"

usage() {
  cat <<EOF
Usage: csd <subcommand> [args...]
       csd --worker <name> <subcommand> [args...]

Top-level subcommands:
  launch <tmux-name> <cwd> [-- claude-args...]   Bootstrap a worker
  list [--all]                                    Enumerate workers
  grant-consent                                   One-time consent flow
  help                                            Show this message

Per-worker subcommands (require --worker, supplied by the shim):
  converse [--with-turn] <prompt> [timeout]
  send <prompt>
  wait-for-turn [timeout]
  status
  read-events [--last N] [--type T] [--follow]
  read-turn [--full]
  stop
  handoff
  session-id
  events-file
EOF
}

TOP_LEVEL_SUBS=(launch list grant-consent help)
PER_WORKER_SUBS=(converse send wait-for-turn status read-events read-turn \
                 stop handoff session-id events-file)

is_in() {
  local needle="$1"; shift
  for x in "$@"; do [ "$x" = "$needle" ] && return 0; done
  return 1
}

if [ -z "$SUB" ]; then
  usage >&2
  exit 2
fi

if is_in "$SUB" "${TOP_LEVEL_SUBS[@]}"; then
  if [ -n "$WORKER" ]; then
    echo "Error: --worker is not valid for '$SUB' (top-level subcommand)" >&2
    exit 2
  fi
elif is_in "$SUB" "${PER_WORKER_SUBS[@]}"; then
  if [ -z "$WORKER" ]; then
    echo "Error: --worker <name> is required for '$SUB'" >&2
    exit 2
  fi
else
  echo "Error: unknown subcommand '$SUB'" >&2
  usage >&2
  exit 2
fi

shift  # consume the subcommand name

case "$SUB" in
  help)
    usage
    ;;
  launch|list|grant-consent|converse|send|wait-for-turn|status|read-events|read-turn|stop|handoff|session-id|events-file)
    # Stubs — implemented in later tasks.
    echo "Error: '$SUB' not yet implemented" >&2
    exit 99
    ;;
esac
```

Make it executable:

```bash
chmod +x skills/driving-claude-code-sessions/scripts/csd
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-skeleton.sh`
Expected: PASS — all dispatch checks succeed.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-skeleton.sh
git commit -m "csd: skeleton with subcommand dispatch and --worker parsing"
```

---

## Task 2: csd grant-consent

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd` (replace the grant-consent stub)
- Test: `tests/test-csd-grant-consent.sh`

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-grant-consent.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Use an isolated HOME so we don't mutate the real consent file.
FAKE_HOME=$(mktemp -d)
trap 'rm -rf "$FAKE_HOME"' EXIT

# --- Test 1: grant-consent writes the consent file given 'yes' on stdin ---
echo "Test 1: writes consent file on yes"
EXIT_CODE=0
OUTPUT=$(HOME="$FAKE_HOME" bash "$CSD" grant-consent <<<"yes" 2>&1) || EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "exits 0 on yes"
else
  fail "exit" "expected 0, got $EXIT_CODE; output: $OUTPUT"
fi
if [ -f "$FAKE_HOME/.claude/.claude-session-driver-consent" ]; then
  pass "consent file written"
else
  fail "consent file" "expected at $FAKE_HOME/.claude/.claude-session-driver-consent"
fi

# --- Test 2: grant-consent refuses non-yes input ---
echo "Test 2: refuses non-yes input"
rm -rf "$FAKE_HOME"
mkdir -p "$FAKE_HOME"
EXIT_CODE=0
OUTPUT=$(HOME="$FAKE_HOME" bash "$CSD" grant-consent <<<"no" 2>&1) || EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  pass "exits non-zero on no"
else
  fail "exit" "expected non-zero, got 0"
fi
if [ ! -f "$FAKE_HOME/.claude/.claude-session-driver-consent" ]; then
  pass "no consent file written"
else
  fail "consent file" "should not exist after refusal"
fi

# --- Test 3: idempotent when already granted ---
echo "Test 3: idempotent when already granted"
mkdir -p "$FAKE_HOME/.claude"
touch "$FAKE_HOME/.claude/.claude-session-driver-consent"
OUTPUT=$(HOME="$FAKE_HOME" bash "$CSD" grant-consent 2>&1)
if echo "$OUTPUT" | grep -qi "already"; then
  pass "reports already granted"
else
  fail "idempotent" "expected 'already' in output, got: $OUTPUT"
fi

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-grant-consent.sh`
Expected: FAIL — grant-consent is a stub that exits 99.

- [ ] **Step 3: Implement grant-consent**

In `scripts/csd`, replace the `grant-consent` case in the dispatch with a function call. Add the function above the dispatch:

```bash
cmd_grant_consent() {
  local consent_file="$HOME/.claude/.claude-session-driver-consent"
  if [ -f "$consent_file" ]; then
    echo "Consent already granted at $consent_file"
    return 0
  fi
  cat <<EOF
claude-session-driver runs workers with --dangerously-skip-permissions.
Workers execute tool calls without prompting. By granting consent, you
acknowledge this risk and accept responsibility for any actions the
worker takes.

Type 'yes' to grant consent: 
EOF
  read -r reply
  if [ "$reply" != "yes" ]; then
    echo "Consent not granted." >&2
    return 1
  fi
  mkdir -p "$(dirname "$consent_file")"
  touch "$consent_file"
  echo "Consent granted. Written: $consent_file"
}
```

Update the dispatch case (replace the existing wildcard branch):

```bash
case "$SUB" in
  help)            usage ;;
  grant-consent)   cmd_grant_consent ;;
  launch|list|converse|send|wait-for-turn|status|read-events|read-turn|stop|handoff|session-id|events-file)
    echo "Error: '$SUB' not yet implemented" >&2
    exit 99
    ;;
esac
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-grant-consent.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-grant-consent.sh
git commit -m "csd: implement grant-consent"
```

---

## Task 3: csd list

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-list.sh`

`csd list` enumerates workers. Default: alive (tmux session exists). `--all`: includes dead. Output is a tab-separated table with header:

```
STATUS  TMUX            SESSION_ID  SHIM                                  CWD
alive   worker-api      7a3c-...    /tmp/claude-workers/bin/worker-api    /path/to/project
```

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-list.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  rm -f "$WDIR"/test-list-*.meta "$WDIR"/test-list-*.events.jsonl
  rm -f "$WDIR"/bin/test-list-*
  tmux kill-session -t test-list-alive 2>/dev/null || true
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR" "$WDIR/bin"

# --- Test 1: empty list prints "No workers found" to stderr, exits 0 ---
echo "Test 1: empty list"
OUTPUT=$(bash "$CSD" list 2>&1)
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ] && echo "$OUTPUT" | grep -qi "no workers"; then
  pass "empty list reports no workers, exit 0"
else
  fail "empty" "exit=$EXIT_CODE, output: $OUTPUT"
fi

# --- Test 2: lists only alive workers by default ---
echo "Test 2: alive only by default"
# Alive worker
tmux new-session -d -s test-list-alive -c /tmp 'sleep 60'
echo '{"tmux_name":"test-list-alive","session_id":"test-list-001","cwd":"/tmp","started_at":"2025-01-01T00:00:00Z"}' > "$WDIR/test-list-001.meta"
touch "$WDIR/bin/test-list-alive"
# Dead worker (no tmux session)
echo '{"tmux_name":"test-list-dead","session_id":"test-list-002","cwd":"/tmp","started_at":"2025-01-01T00:00:00Z"}' > "$WDIR/test-list-002.meta"

OUTPUT=$(bash "$CSD" list 2>&1)
if echo "$OUTPUT" | grep -q "test-list-alive"; then
  pass "alive worker listed"
else
  fail "alive missing" "$OUTPUT"
fi
if echo "$OUTPUT" | grep -q "test-list-dead"; then
  fail "dead included by default" "should be excluded without --all"
else
  pass "dead worker excluded by default"
fi
if echo "$OUTPUT" | grep -q "/tmp/claude-workers/bin/test-list-alive"; then
  pass "shim path included in output"
else
  fail "shim path" "expected shim path in row, got: $OUTPUT"
fi

# --- Test 3: --all includes dead workers ---
echo "Test 3: --all includes dead"
OUTPUT=$(bash "$CSD" list --all 2>&1)
if echo "$OUTPUT" | grep -q "test-list-dead"; then
  pass "dead worker included with --all"
else
  fail "dead with --all" "$OUTPUT"
fi

# --- Test 4: output has a header line ---
echo "Test 4: header row"
OUTPUT=$(bash "$CSD" list --all 2>&1)
if echo "$OUTPUT" | head -1 | grep -qE "STATUS.*TMUX.*SHIM"; then
  pass "header row present"
else
  fail "header" "first line: $(echo "$OUTPUT" | head -1)"
fi

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-list.sh`
Expected: FAIL — list is a stub.

- [ ] **Step 3: Implement list**

In `scripts/csd`, add `cmd_list`:

```bash
cmd_list() {
  local show_dead=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) show_dead=1; shift ;;
      *) echo "Error: unknown option '$1' for list" >&2; return 2 ;;
    esac
  done

  local worker_dir=/tmp/claude-workers
  shopt -s nullglob
  local metas=("$worker_dir"/*.meta)
  shopt -u nullglob
  if [ "${#metas[@]}" -eq 0 ]; then
    echo "No workers found" >&2
    return 0
  fi

  printf '%s\t%s\t%s\t%s\t%s\n' STATUS TMUX SESSION_ID SHIM CWD
  local meta tmux_name session_id cwd status
  for meta in "${metas[@]}"; do
    tmux_name=$(jq -r '.tmux_name' "$meta")
    session_id=$(jq -r '.session_id' "$meta")
    cwd=$(jq -r '.cwd' "$meta")
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
      status=alive
    else
      status=dead
      [ "$show_dead" -eq 0 ] && continue
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$status" "$tmux_name" "$session_id" \
      "/tmp/claude-workers/bin/$tmux_name" "$cwd"
  done
}
```

Wire it into the dispatch (replace the existing case branch):

```bash
case "$SUB" in
  help)            usage ;;
  grant-consent)   cmd_grant_consent ;;
  list)            cmd_list "$@" ;;
  launch|converse|send|wait-for-turn|status|read-events|read-turn|stop|handoff|session-id|events-file)
    echo "Error: '$SUB' not yet implemented" >&2
    exit 99
    ;;
esac
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-list.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-list.sh
git commit -m "csd: implement list with shim path column"
```

---

## Task 4: csd session-id and events-file

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-readers.sh`

These are trivial meta readers. Useful as the first per-worker subcommands because they exercise the `--worker` resolution path with minimal logic.

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-readers.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  rm -f "$WDIR"/test-readers-*.meta "$WDIR"/test-readers-*.events.jsonl
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR"

SESSION_ID="test-readers-abc"
TMUX_NAME="test-readers"
echo "{\"tmux_name\":\"$TMUX_NAME\",\"session_id\":\"$SESSION_ID\",\"cwd\":\"/tmp\",\"started_at\":\"2025-01-01T00:00:00Z\"}" > "$WDIR/$SESSION_ID.meta"

# --- session-id by tmux name ---
echo "Test 1: session-id by tmux name"
OUTPUT=$(bash "$CSD" --worker "$TMUX_NAME" session-id)
if [ "$OUTPUT" = "$SESSION_ID" ]; then
  pass "returns session_id"
else
  fail "session-id" "expected $SESSION_ID, got $OUTPUT"
fi

# --- session-id by session id passthrough ---
echo "Test 2: session-id by session_id"
OUTPUT=$(bash "$CSD" --worker "$SESSION_ID" session-id)
if [ "$OUTPUT" = "$SESSION_ID" ]; then
  pass "session_id passthrough"
else
  fail "passthrough" "expected $SESSION_ID, got $OUTPUT"
fi

# --- events-file path ---
echo "Test 3: events-file"
OUTPUT=$(bash "$CSD" --worker "$TMUX_NAME" events-file)
EXPECTED="/tmp/claude-workers/$SESSION_ID.events.jsonl"
if [ "$OUTPUT" = "$EXPECTED" ]; then
  pass "events-file path"
else
  fail "events-file" "expected $EXPECTED, got $OUTPUT"
fi

# --- unknown worker fails ---
echo "Test 4: unknown worker fails"
EXIT_CODE=0
OUTPUT=$(bash "$CSD" --worker no-such-worker session-id 2>&1) || EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  pass "unknown worker exits non-zero"
else
  fail "unknown worker" "expected non-zero exit"
fi

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-readers.sh`
Expected: FAIL — both subcommands are stubs.

- [ ] **Step 3: Implement session-id and events-file**

In `scripts/csd`, add:

```bash
cmd_session_id() {
  resolve_session "$WORKER"
}

cmd_events_file() {
  local sid
  sid=$(resolve_session "$WORKER")
  echo "/tmp/claude-workers/${sid}.events.jsonl"
}
```

Update dispatch:

```bash
case "$SUB" in
  help)            usage ;;
  grant-consent)   cmd_grant_consent ;;
  list)            cmd_list "$@" ;;
  session-id)      cmd_session_id ;;
  events-file)     cmd_events_file ;;
  launch|converse|send|wait-for-turn|status|read-events|read-turn|stop|handoff)
    echo "Error: '$SUB' not yet implemented" >&2
    exit 99
    ;;
esac
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-readers.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-readers.sh
git commit -m "csd: implement session-id and events-file readers"
```

---

## Task 5: csd status

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-status.sh`

Status precedence (same as legacy status.sh): `gone` (tmux dead) > `terminated` (last event = session_end) > `working` (last event = user_prompt_submit | pre_tool_use) > `idle` (last event = stop | session_start) > `unknown` (no events file).

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-status.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  tmux kill-session -t test-status-alive 2>/dev/null || true
  rm -f "$WDIR"/test-status-*.meta "$WDIR"/test-status-*.events.jsonl
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR"

# --- gone: tmux session does not exist ---
echo '{"tmux_name":"test-status-gone","session_id":"test-status-001","cwd":"/tmp"}' > "$WDIR/test-status-001.meta"
echo '{"event":"stop"}' > "$WDIR/test-status-001.events.jsonl"
OUTPUT=$(bash "$CSD" --worker test-status-gone status)
[ "$OUTPUT" = "gone" ] && pass "gone when tmux missing" || fail "gone" "got '$OUTPUT'"

# --- live tmux but various last events ---
tmux new-session -d -s test-status-alive -c /tmp 'sleep 60'
echo '{"tmux_name":"test-status-alive","session_id":"test-status-002","cwd":"/tmp"}' > "$WDIR/test-status-002.meta"

# unknown: no events file
rm -f "$WDIR/test-status-002.events.jsonl"
OUTPUT=$(bash "$CSD" --worker test-status-alive status)
[ "$OUTPUT" = "unknown" ] && pass "unknown when no events" || fail "unknown" "got '$OUTPUT'"

# idle: last event = session_start
echo '{"event":"session_start","cwd":"/tmp"}' > "$WDIR/test-status-002.events.jsonl"
OUTPUT=$(bash "$CSD" --worker test-status-alive status)
[ "$OUTPUT" = "idle" ] && pass "idle on session_start" || fail "idle/session_start" "got '$OUTPUT'"

# idle: last event = stop
echo '{"event":"stop"}' >> "$WDIR/test-status-002.events.jsonl"
OUTPUT=$(bash "$CSD" --worker test-status-alive status)
[ "$OUTPUT" = "idle" ] && pass "idle on stop" || fail "idle/stop" "got '$OUTPUT'"

# working: last event = user_prompt_submit
echo '{"event":"user_prompt_submit"}' >> "$WDIR/test-status-002.events.jsonl"
OUTPUT=$(bash "$CSD" --worker test-status-alive status)
[ "$OUTPUT" = "working" ] && pass "working on user_prompt_submit" || fail "working/ups" "got '$OUTPUT'"

# working: last event = pre_tool_use
echo '{"event":"pre_tool_use","tool":"Bash","tool_input":{}}' >> "$WDIR/test-status-002.events.jsonl"
OUTPUT=$(bash "$CSD" --worker test-status-alive status)
[ "$OUTPUT" = "working" ] && pass "working on pre_tool_use" || fail "working/ptu" "got '$OUTPUT'"

# terminated: last event = session_end
echo '{"event":"session_end"}' >> "$WDIR/test-status-002.events.jsonl"
OUTPUT=$(bash "$CSD" --worker test-status-alive status)
[ "$OUTPUT" = "terminated" ] && pass "terminated on session_end" || fail "terminated" "got '$OUTPUT'"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-status.sh`
Expected: FAIL — status is a stub.

- [ ] **Step 3: Implement status**

Add to `scripts/csd`:

```bash
cmd_status() {
  local sid tmux_name event_file last_event
  sid=$(resolve_session "$WORKER")
  tmux_name=$(jq -r '.tmux_name' "/tmp/claude-workers/${sid}.meta")

  if ! tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "gone"
    return 0
  fi

  event_file="/tmp/claude-workers/${sid}.events.jsonl"
  if [ ! -f "$event_file" ]; then
    echo "unknown"
    return 0
  fi

  last_event=$(tail -1 "$event_file" | jq -r '.event' 2>/dev/null || echo "")
  case "$last_event" in
    session_end)                    echo "terminated" ;;
    user_prompt_submit|pre_tool_use) echo "working" ;;
    stop|session_start)             echo "idle" ;;
    *)                              echo "unknown" ;;
  esac
}
```

Update dispatch — add `status)  cmd_status ;;` and remove `status` from the not-yet-implemented list.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-status.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-status.sh
git commit -m "csd: implement status with same precedence as legacy script"
```

---

## Task 6: csd read-events

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-read-events.sh`

Port from `scripts/read-events.sh`. Supports `--last N`, `--type T` (validated), `--follow`.

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-read-events.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  rm -f "$WDIR"/test-re-*.meta "$WDIR"/test-re-*.events.jsonl
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR"

SID="test-re-001"
echo '{"tmux_name":"test-re","session_id":"test-re-001","cwd":"/tmp"}' > "$WDIR/$SID.meta"
EF="$WDIR/$SID.events.jsonl"
cat > "$EF" <<'JSON'
{"ts":"t1","event":"session_start","cwd":"/tmp"}
{"ts":"t2","event":"user_prompt_submit"}
{"ts":"t3","event":"pre_tool_use","tool":"Bash","tool_input":{}}
{"ts":"t4","event":"stop"}
{"ts":"t5","event":"user_prompt_submit"}
{"ts":"t6","event":"stop"}
JSON

# default shows all events
OUTPUT=$(bash "$CSD" --worker test-re read-events)
COUNT=$(echo "$OUTPUT" | wc -l | tr -d ' ')
[ "$COUNT" = "6" ] && pass "default shows all 6 events" || fail "default count" "got $COUNT"

# --type stop filters
OUTPUT=$(bash "$CSD" --worker test-re read-events --type stop)
COUNT=$(echo "$OUTPUT" | wc -l | tr -d ' ')
[ "$COUNT" = "2" ] && pass "--type stop returns 2" || fail "type stop" "got $COUNT"

# --last 3
OUTPUT=$(bash "$CSD" --worker test-re read-events --last 3)
COUNT=$(echo "$OUTPUT" | wc -l | tr -d ' ')
[ "$COUNT" = "3" ] && pass "--last 3 returns 3" || fail "last 3" "got $COUNT"

# --type with --last
OUTPUT=$(bash "$CSD" --worker test-re read-events --type stop --last 1)
COUNT=$(echo "$OUTPUT" | wc -l | tr -d ' ')
[ "$COUNT" = "1" ] && pass "--type stop --last 1" || fail "type+last" "got $COUNT"

# invalid event type fails fast
EXIT_CODE=0
OUTPUT=$(bash "$CSD" --worker test-re read-events --type end_of_turn 2>&1) || EXIT_CODE=$?
[ "$EXIT_CODE" -ne 0 ] && pass "invalid --type exits non-zero" || fail "invalid type" "got 0"
echo "$OUTPUT" | grep -qi "not a known event" && pass "error names problem" || fail "msg" "$OUTPUT"

# missing event file errors
rm -f "$EF"
EXIT_CODE=0
bash "$CSD" --worker test-re read-events 2>/dev/null || EXIT_CODE=$?
[ "$EXIT_CODE" -ne 0 ] && pass "missing file exits non-zero" || fail "missing file" "exit 0"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-read-events.sh`
Expected: FAIL — read-events is a stub.

- [ ] **Step 3: Implement read-events**

Add to `scripts/csd`:

```bash
cmd_read_events() {
  local last="" type="" follow=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --last)   last="$2"; shift 2 ;;
      --type)   type="$2"; shift 2 ;;
      --follow) follow=true; shift ;;
      *) echo "Error: unknown option '$1' for read-events" >&2; return 2 ;;
    esac
  done
  if [ -n "$type" ]; then
    validate_event_type "$type"
  fi

  local sid event_file
  sid=$(resolve_session "$WORKER")
  event_file="/tmp/claude-workers/${sid}.events.jsonl"
  if [ ! -f "$event_file" ]; then
    echo "Error: No event file for session $sid" >&2
    return 1
  fi

  if [ "$follow" = true ]; then
    tail -f "$event_file" | while IFS= read -r line; do
      if [ -n "$type" ]; then
        local e
        e=$(echo "$line" | jq -r '.event // empty' 2>/dev/null) || continue
        [ "$e" = "$type" ] && echo "$line"
      else
        echo "$line"
      fi
    done
  else
    local data
    data=$(cat "$event_file")
    if [ -n "$type" ]; then
      data=$(echo "$data" | jq -c "select(.event == \"$type\")")
    fi
    if [ -n "$last" ]; then
      echo "$data" | tail -n "$last"
    else
      echo "$data"
    fi
  fi
}
```

Wire into dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-read-events.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-read-events.sh
git commit -m "csd: implement read-events with --last/--type/--follow"
```

---

## Task 7: csd wait-for-turn

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-wait-for-turn.sh`

`wait-for-turn` blocks until **stop OR session_end** appears in the events file. Supports `--after-line N` so converse can call it after sending a prompt without re-matching the old turn boundary.

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-wait-for-turn.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  rm -f "$WDIR"/test-wt-*.meta "$WDIR"/test-wt-*.events.jsonl
  jobs -p 2>/dev/null | xargs kill 2>/dev/null || true
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR"

# --- matches existing stop ---
echo '{"tmux_name":"test-wt-1","session_id":"test-wt-001","cwd":"/tmp"}' > "$WDIR/test-wt-001.meta"
echo '{"ts":"t1","event":"stop"}' > "$WDIR/test-wt-001.events.jsonl"
OUT=$(bash "$CSD" --worker test-wt-1 wait-for-turn 5)
EC=$?
[ "$EC" = "0" ] && pass "matches existing stop" || fail "stop existing" "exit $EC"
echo "$OUT" | jq -r '.event' | grep -q '^stop$' && pass "stop event returned" || fail "event field" "$OUT"

# --- matches existing session_end ---
echo '{"tmux_name":"test-wt-2","session_id":"test-wt-002","cwd":"/tmp"}' > "$WDIR/test-wt-002.meta"
echo '{"ts":"t1","event":"session_end"}' > "$WDIR/test-wt-002.events.jsonl"
OUT=$(bash "$CSD" --worker test-wt-2 wait-for-turn 5)
echo "$OUT" | jq -r '.event' | grep -q '^session_end$' && pass "matches session_end" || fail "session_end" "$OUT"

# --- matches stop appended later ---
echo '{"tmux_name":"test-wt-3","session_id":"test-wt-003","cwd":"/tmp"}' > "$WDIR/test-wt-003.meta"
echo '{"ts":"t0","event":"session_start","cwd":"/tmp"}' > "$WDIR/test-wt-003.events.jsonl"
(sleep 1 && echo '{"ts":"t1","event":"stop"}' >> "$WDIR/test-wt-003.events.jsonl") &
OUT=$(bash "$CSD" --worker test-wt-3 wait-for-turn 5)
echo "$OUT" | jq -r '.event' | grep -q '^stop$' && pass "matches stop appended later" || fail "late stop" "$OUT"

# --- skips earlier stop with --after-line ---
echo '{"tmux_name":"test-wt-4","session_id":"test-wt-004","cwd":"/tmp"}' > "$WDIR/test-wt-004.meta"
cat > "$WDIR/test-wt-004.events.jsonl" <<'JSON'
{"ts":"t0","event":"session_start","cwd":"/tmp"}
{"ts":"t1","event":"stop"}
JSON
EC=0
OUT=$(bash "$CSD" --worker test-wt-4 wait-for-turn 2 --after-line 2 2>/dev/null) || EC=$?
[ "$EC" = "1" ] && pass "--after-line 2 skips existing stop" || fail "after-line" "exit $EC, out $OUT"

# Append a fresh stop, --after-line 2 should match it
echo '{"ts":"t2","event":"stop"}' >> "$WDIR/test-wt-004.events.jsonl"
OUT=$(bash "$CSD" --worker test-wt-4 wait-for-turn 5 --after-line 2)
TS=$(echo "$OUT" | jq -r '.ts')
[ "$TS" = "t2" ] && pass "--after-line finds new stop" || fail "fresh stop" "got ts=$TS"

# --- timeout on no event ---
echo '{"tmux_name":"test-wt-5","session_id":"test-wt-005","cwd":"/tmp"}' > "$WDIR/test-wt-005.meta"
echo '{"ts":"t0","event":"session_start","cwd":"/tmp"}' > "$WDIR/test-wt-005.events.jsonl"
EC=0
bash "$CSD" --worker test-wt-5 wait-for-turn 2 >/dev/null 2>&1 || EC=$?
[ "$EC" = "1" ] && pass "exit 1 on timeout" || fail "timeout exit" "got $EC"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-wait-for-turn.sh`
Expected: FAIL — wait-for-turn is a stub.

- [ ] **Step 3: Implement wait-for-turn**

Add to `scripts/csd`:

```bash
cmd_wait_for_turn() {
  local timeout=60 after_line=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --after-line) after_line="$2"; shift 2 ;;
      [0-9]*)       timeout="$1"; shift ;;
      *) echo "Error: unknown option '$1' for wait-for-turn" >&2; return 2 ;;
    esac
  done

  local sid event_file
  sid=$(resolve_session "$WORKER")
  event_file="/tmp/claude-workers/${sid}.events.jsonl"
  local deadline=$((SECONDS + timeout))

  while [ ! -f "$event_file" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Timeout waiting for event file: $event_file" >&2
      return 1
    fi
    sleep 0.5
  done

  local lines_checked=$after_line
  while [ "$SECONDS" -lt "$deadline" ]; do
    local current_lines
    current_lines=$(wc -l < "$event_file" | tr -d ' ')
    if [ "$current_lines" -gt "$lines_checked" ]; then
      local match
      match=$(tail -n +"$((lines_checked + 1))" "$event_file" \
        | jq -c 'select(.event == "stop" or .event == "session_end")' 2>/dev/null \
        | head -1)
      if [ -n "$match" ]; then
        echo "$match"
        return 0
      fi
      lines_checked=$current_lines
    fi
    sleep 0.5
  done

  echo "Timeout waiting for turn (stop or session_end) after ${timeout}s" >&2
  return 1
}
```

Wire into dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-wait-for-turn.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-wait-for-turn.sh
git commit -m "csd: implement wait-for-turn matching stop OR session_end"
```

---

## Task 8: csd read-turn

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-read-turn.sh`

Port from `scripts/read-turn.sh`. Reads the Claude session JSONL log, finds the last user prompt, formats subsequent assistant/user messages as markdown. `--full` keeps complete tool results.

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-read-turn.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Use a synthetic HOME so we don't touch the real ~/.claude/projects.
FAKE_HOME=$(mktemp -d)
trap 'rm -rf "$FAKE_HOME"; rm -f /tmp/claude-workers/test-rt-*' EXIT
mkdir -p "$WDIR"

SID="test-rt-001"
TMUX="test-rt"
CWD="$FAKE_HOME/proj"
mkdir -p "$CWD"
ENC=$(echo "$CWD" | sed 's|/|-|g')
LOG_DIR="$FAKE_HOME/.claude/projects/$ENC"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$SID.jsonl"

echo "{\"tmux_name\":\"$TMUX\",\"session_id\":\"$SID\",\"cwd\":\"$CWD\"}" > "$WDIR/$SID.meta"

# Minimal log with one prompt and one assistant text reply
cat > "$LOG" <<'JSON'
{"type":"user","message":{"content":"Hello"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"World"}]}}
JSON

OUTPUT=$(HOME="$FAKE_HOME" bash "$CSD" --worker "$TMUX" read-turn)
echo "$OUTPUT" | grep -q "Hello" && pass "prompt appears" || fail "prompt" "$OUTPUT"
echo "$OUTPUT" | grep -q "World" && pass "response appears" || fail "response" "$OUTPUT"

# Missing log file errors clearly
rm -f "$LOG"
EC=0
HOME="$FAKE_HOME" bash "$CSD" --worker "$TMUX" read-turn 2>/dev/null || EC=$?
[ "$EC" -ne 0 ] && pass "missing log fails" || fail "missing log" "exit 0"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-read-turn.sh`
Expected: FAIL — read-turn is a stub.

- [ ] **Step 3: Implement read-turn**

Add to `scripts/csd`. This is the same logic as legacy `read-turn.sh` — port verbatim:

```bash
cmd_read_turn() {
  local full=false
  if [ "${1:-}" = "--full" ]; then
    full=true
    shift
  fi

  local sid cwd encoded log_file last_prompt_line
  sid=$(resolve_session "$WORKER")
  cwd=$(jq -r '.cwd' "/tmp/claude-workers/${sid}.meta" 2>/dev/null)
  if [ -z "$cwd" ] || [ "$cwd" = "null" ]; then
    echo "Error: Could not determine working directory from meta file" >&2
    return 1
  fi
  if [ -d "$cwd" ]; then
    cwd=$(cd "$cwd" && pwd -P)
  fi
  encoded=$(echo "$cwd" | sed 's|/|-|g')
  log_file="$HOME/.claude/projects/${encoded}/${sid}.jsonl"

  if [ ! -f "$log_file" ]; then
    echo "Error: Session log not found at $log_file" >&2
    return 1
  fi

  last_prompt_line=$(grep -n '"type":"user"' "$log_file" \
    | grep -v '"tool_result"' \
    | grep -v '<local-command' \
    | grep -v '<command-name>' \
    | tail -1 \
    | cut -d: -f1)

  if [ -z "$last_prompt_line" ]; then
    echo "No user prompt found in session log" >&2
    return 1
  fi

  tail -n +"$last_prompt_line" "$log_file" \
    | jq -r --argjson full "$full" '
      select(.type == "assistant" or .type == "user") |
      if .type == "user" then
        if (.message.content | type) == "string" then
          if (.message.content | test("^<(local-command|command-name)")) then empty
          else "---\n\n**Prompt:** " + .message.content + "\n" end
        else
          .message.content[] | select(.type == "tool_result") |
          if .is_error then
            "**Tool Error:**\n```\n" + (.content // "(no output)") + "\n```\n"
          else
            if $full then
              "**Result:**\n```\n" + (.content // "(no output)") + "\n```\n"
            else
              "**Result:**\n```\n" + ((.content // "(no output)") | split("\n") | if length > 5 then (.[0:5] | join("\n")) + "\n... (" + (length | tostring) + " lines total)" else join("\n") end) + "\n```\n"
            end
          end
        end
      elif .type == "assistant" then
        .message.content[] |
        if .type == "thinking" then "> **Thinking:** " + (.thinking | split("\n") | join("\n> ")) + "\n"
        elif .type == "text" then .text + "\n"
        elif .type == "tool_use" then "**Tool: " + .name + "**\n```json\n" + (.input | tostring) + "\n```\n"
        else empty
        end
      else empty
      end
    ' 2>/dev/null
}
```

Wire into dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-read-turn.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-read-turn.sh
git commit -m "csd: implement read-turn"
```

---

## Task 9: csd send

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-send.sh`

Port from `scripts/send-prompt.sh`. Bracketed-paste markers, 100ms settle, Enter.

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-send.sh`. This test launches a real tmux session running cat (no claude needed) and verifies the bytes arrive:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

TMUX_NAME="test-csd-send"
OUTFILE=$(mktemp)
cleanup() {
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  rm -f "$OUTFILE" "$WDIR/test-send-001.meta"
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR"

echo "{\"tmux_name\":\"$TMUX_NAME\",\"session_id\":\"test-send-001\",\"cwd\":\"/tmp\"}" > "$WDIR/test-send-001.meta"

# Start a tmux session that just appends every line to OUTFILE
tmux new-session -d -s "$TMUX_NAME" "while IFS= read -r line; do echo \"\$line\" >> $OUTFILE; done"
sleep 0.2

bash "$CSD" --worker "$TMUX_NAME" send "hello world"
sleep 0.5

if grep -q "hello world" "$OUTFILE"; then
  pass "prompt arrives at tmux pane"
else
  fail "send" "no 'hello world' in $OUTFILE: $(cat "$OUTFILE")"
fi

# Missing tmux session
tmux kill-session -t "$TMUX_NAME" 2>/dev/null
EC=0
bash "$CSD" --worker "$TMUX_NAME" send "x" 2>/dev/null || EC=$?
[ "$EC" -ne 0 ] && pass "missing tmux fails" || fail "missing tmux" "exit 0"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-send.sh`
Expected: FAIL — send is a stub.

- [ ] **Step 3: Implement send**

Add to `scripts/csd`:

```bash
cmd_send() {
  local prompt="${1:?Usage: send <prompt-text>}"
  local sid tmux_name
  sid=$(resolve_session "$WORKER")
  tmux_name=$(jq -r '.tmux_name' "/tmp/claude-workers/${sid}.meta")

  if ! tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "Error: tmux session '$tmux_name' does not exist" >&2
    return 1
  fi

  local ESC PASTE_START PASTE_END SAFE
  ESC=$'\x1b'
  PASTE_START="${ESC}[200~"
  PASTE_END="${ESC}[201~"
  SAFE=${prompt//${PASTE_END}/}
  SAFE=${SAFE//${PASTE_START}/}

  tmux send-keys -t "$tmux_name" -l "${PASTE_START}${SAFE}${PASTE_END}"
  sleep 0.1
  tmux send-keys -t "$tmux_name" Enter
}
```

Wire into dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-send.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-send.sh
git commit -m "csd: implement send with bracketed-paste"
```

---

## Task 10: csd converse

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-converse.sh`

Port from `scripts/converse.sh`. Difference: calls `cmd_wait_for_turn` instead of the legacy wait-for-event. Supports `--with-turn` flag.

Because converse depends on a real Claude session log appearing after a prompt, this test exercises the **internal flow** with synthetic data — we don't need a live worker. We pre-populate the log with a "before" state, simulate the send by injecting a stop event, simulate the log update, and verify converse returns the new assistant text.

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-converse.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

FAKE_HOME=$(mktemp -d)
TMUX_NAME="test-csd-converse"
SID="test-conv-001"
CWD="$FAKE_HOME/proj"
mkdir -p "$CWD"
ENC=$(echo "$CWD" | sed 's|/|-|g')
LOG_DIR="$FAKE_HOME/.claude/projects/$ENC"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$SID.jsonl"

cleanup() {
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  rm -rf "$FAKE_HOME"
  rm -f "$WDIR/$SID.meta" "$WDIR/$SID.events.jsonl"
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR"

# Set up: real tmux session that swallows input (we don't care about send),
# meta with cwd, empty event file, pre-existing log with a prior turn.
tmux new-session -d -s "$TMUX_NAME" 'cat >/dev/null'
echo "{\"tmux_name\":\"$TMUX_NAME\",\"session_id\":\"$SID\",\"cwd\":\"$CWD\"}" > "$WDIR/$SID.meta"
echo '{"ts":"t0","event":"session_start","cwd":"'"$CWD"'"}' > "$WDIR/$SID.events.jsonl"

# Pre-existing log: one prior user/assistant exchange
cat > "$LOG" <<'JSON'
{"type":"user","message":{"content":"first prompt"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"first response"}]}}
JSON

# Run converse in the background. It will send (no-op into cat), then wait
# for stop. Inject a new assistant message and a stop event after 0.5s.
(
  sleep 0.5
  cat >> "$LOG" <<'JSON'
{"type":"user","message":{"content":"second prompt"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"second response"}]}}
JSON
  echo '{"ts":"t1","event":"stop"}' >> "$WDIR/$SID.events.jsonl"
) &

OUTPUT=$(HOME="$FAKE_HOME" bash "$CSD" --worker "$TMUX_NAME" converse "second prompt" 5)
EC=$?

[ "$EC" -eq 0 ] && pass "converse exits 0" || fail "exit" "got $EC; output: $OUTPUT"
echo "$OUTPUT" | grep -q "second response" && pass "returns new response text" || fail "text" "$OUTPUT"
echo "$OUTPUT" | grep -q "first response" && fail "returns old text" "should only return new" || pass "does not return old response"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-converse.sh`
Expected: FAIL — converse is a stub.

- [ ] **Step 3: Implement converse**

Add to `scripts/csd`:

```bash
cmd_converse() {
  local with_turn=0
  if [ "${1:-}" = "--with-turn" ]; then
    with_turn=1
    shift
  fi
  local prompt="${1:?Usage: converse [--with-turn] <prompt> [timeout=120]}"
  local timeout="${2:-120}"

  local sid cwd encoded log_file event_file
  sid=$(resolve_session "$WORKER")
  cwd=$(jq -r '.cwd' "/tmp/claude-workers/${sid}.meta" 2>/dev/null)
  if [ -z "$cwd" ] || [ "$cwd" = "null" ]; then
    echo "Error: Could not determine working directory from meta file" >&2
    return 1
  fi
  if [ -d "$cwd" ]; then
    cwd=$(cd "$cwd" && pwd -P)
  fi
  encoded=$(echo "$cwd" | sed 's|/|-|g')
  log_file="$HOME/.claude/projects/${encoded}/${sid}.jsonl"
  event_file="/tmp/claude-workers/${sid}.events.jsonl"

  count_text_messages() {
    if [ ! -f "$log_file" ]; then echo 0; return; fi
    local r
    r=$(grep '"type":"assistant"' "$log_file" \
        | jq -s '[.[] | select(.message.content | any(.type == "text"))] | length' 2>/dev/null) || r=0
    echo "$r"
  }
  last_text_response() {
    grep '"type":"assistant"' "$log_file" \
      | jq -rs 'map(select(.message.content | any(.type == "text"))) | last | [.message.content[] | select(.type == "text") | .text] | join("\n")' 2>/dev/null
  }

  local before_count after_line
  before_count=$(count_text_messages)
  after_line=0
  [ -f "$event_file" ] && after_line=$(wc -l < "$event_file" | tr -d ' ')

  cmd_send "$prompt"

  if ! cmd_wait_for_turn "$timeout" --after-line "$after_line" >/dev/null; then
    echo "Error: Worker did not finish within ${timeout}s" >&2
    return 1
  fi

  local i after_count
  for i in $(seq 1 20); do
    [ -f "$log_file" ] || { sleep 0.1; continue; }
    after_count=$(count_text_messages)
    if [ "$after_count" -gt "$before_count" ]; then
      if [ "$with_turn" -eq 1 ]; then
        cmd_read_turn
        return 0
      fi
      local response
      response=$(last_text_response)
      if [ -n "$response" ]; then
        echo "$response"
        return 0
      fi
    fi
    sleep 0.1
  done

  echo "Error: Timed out waiting for assistant response in session log" >&2
  return 1
}
```

Wire into dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-converse.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-converse.sh
git commit -m "csd: implement converse calling wait-for-turn"
```

---

## Task 11: csd handoff

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-handoff.sh`

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-handoff.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  rm -f "$WDIR/test-handoff-001.meta"
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR"

echo '{"tmux_name":"test-handoff","session_id":"test-handoff-001","cwd":"/tmp"}' > "$WDIR/test-handoff-001.meta"

OUTPUT=$(bash "$CSD" --worker test-handoff handoff)
echo "$OUTPUT" | grep -q "tmux attach -t test-handoff" && pass "includes attach command" || fail "attach" "$OUTPUT"
echo "$OUTPUT" | grep -qi "ctrl-b d" && pass "includes detach instructions" || fail "detach" "$OUTPUT"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-handoff.sh`
Expected: FAIL.

- [ ] **Step 3: Implement handoff**

Add to `scripts/csd`:

```bash
cmd_handoff() {
  local sid tmux_name
  sid=$(resolve_session "$WORKER")
  tmux_name=$(jq -r '.tmux_name' "/tmp/claude-workers/${sid}.meta")
  cat <<EOF
The worker is running in tmux session '$tmux_name'. To take over:

    tmux attach -t $tmux_name

Once attached, you can type to the worker directly. Detach with Ctrl-B d to
return without ending the session.

Leave the worker running. The controller can resume by sending another
prompt — do not run \`$WORKER stop\` unless you actually want to terminate
the session.
EOF
}
```

Wire into dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-handoff.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-handoff.sh
git commit -m "csd: implement handoff"
```

---

## Task 12: csd launch

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-launch.sh`

This is the big one. Launch generates the shim, writes the meta with `cwd` and `invocation`, starts tmux, waits for `session_start`, then prints the shim path to stdout and the human panel to stderr.

The meta file format gains an `invocation` field (a JSON array of argv elements as they were passed to `csd launch`, including the absolute csd path) used to build the `reproduce:` line. The shim path is `/tmp/claude-workers/bin/<tmux-name>`.

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-launch.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

TMUX_NAME="test-csd-launch-$$"
FAKE_HOME=$(mktemp -d)
cleanup() {
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  rm -rf "$FAKE_HOME"
  rm -f "$WDIR"/*-test-launch-*.meta
  rm -f "$WDIR/bin/$TMUX_NAME"
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR" "$WDIR/bin" "$FAKE_HOME/.claude"
touch "$FAKE_HOME/.claude/.claude-session-driver-consent"

# Use the harness's existing fake-claude trick: launch points at a /bin/sh that
# emits session_start by writing to /tmp/claude-workers/<sid>.events.jsonl.
# We need the session_id, so we wrap a tiny helper that the test injects via
# the test-mode flag --test-claude-cmd.

# Simpler approach: skip the real claude. Provide a fake CLAUDE_BIN env var
# that csd respects when set, pointing at a stub that writes session_start.
FAKE_CLAUDE=$(mktemp)
cat > "$FAKE_CLAUDE" <<'BASH'
#!/bin/bash
# Stub claude that writes a session_start event keyed off --session-id.
SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) SID="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p /tmp/claude-workers
echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"event\":\"session_start\",\"cwd\":\"$PWD\"}" \
  > "/tmp/claude-workers/${SID}.events.jsonl"
# Stay alive so tmux session persists
exec sleep 60
BASH
chmod +x "$FAKE_CLAUDE"

OUTPUT=$(CSD_CLAUDE_BIN="$FAKE_CLAUDE" HOME="$FAKE_HOME" \
         bash "$CSD" launch "$TMUX_NAME" /tmp -- --model sonnet 2>/tmp/launch-stderr-$$)
STDERR=$(cat /tmp/launch-stderr-$$ || true); rm -f /tmp/launch-stderr-$$
EXPECTED_SHIM="/tmp/claude-workers/bin/$TMUX_NAME"

# stdout is exactly the shim path
if [ "$OUTPUT" = "$EXPECTED_SHIM" ]; then
  pass "stdout is the shim path"
else
  fail "stdout" "expected '$EXPECTED_SHIM', got '$OUTPUT'"
fi

# shim file exists and is executable
if [ -x "$EXPECTED_SHIM" ]; then
  pass "shim is executable"
else
  fail "shim exec" "$EXPECTED_SHIM not executable"
fi

# shim execs into csd with --worker baked in
SHIM_BODY=$(cat "$EXPECTED_SHIM")
if echo "$SHIM_BODY" | grep -q "exec.*csd.*--worker $TMUX_NAME"; then
  pass "shim execs csd with --worker"
else
  fail "shim body" "$SHIM_BODY"
fi

# stderr contains reproduce line with the full invocation
if echo "$STDERR" | grep -q "reproduce:.*launch $TMUX_NAME /tmp -- --model sonnet"; then
  pass "stderr has reproduce line"
else
  fail "reproduce" "$STDERR"
fi

# meta file has cwd and invocation fields
META=$(ls "$WDIR"/*.meta | xargs grep -l "$TMUX_NAME" | head -1)
if jq -e '.cwd' "$META" >/dev/null; then
  pass "meta has cwd"
else
  fail "meta cwd" "$(cat "$META")"
fi
if jq -e '.invocation' "$META" >/dev/null; then
  pass "meta has invocation"
else
  fail "meta invocation" "$(cat "$META")"
fi

# Running the shim should dispatch into csd: session-id returns the worker's id
SID_VIA_SHIM=$("$EXPECTED_SHIM" session-id)
SID_IN_META=$(jq -r '.session_id' "$META")
[ "$SID_VIA_SHIM" = "$SID_IN_META" ] && pass "shim routes to the right worker" || fail "shim routing" "$SID_VIA_SHIM vs $SID_IN_META"

# Collision: second launch with same tmux name should fail
EC=0
CSD_CLAUDE_BIN="$FAKE_CLAUDE" HOME="$FAKE_HOME" \
  bash "$CSD" launch "$TMUX_NAME" /tmp 2>/dev/null >/dev/null || EC=$?
[ "$EC" -ne 0 ] && pass "collision rejected" || fail "collision" "exit 0"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-launch.sh`
Expected: FAIL — launch is a stub.

- [ ] **Step 3: Implement launch**

Add to `scripts/csd`. Note: `$CSD_PATH` (from skeleton) is the absolute path to csd, used both for `--plugin-dir` resolution and for the shim body.

```bash
cmd_launch() {
  local tmux_name="${1:?Usage: launch <tmux-name> <cwd> [-- claude-args...]}"
  local working_dir="${2:?Usage: launch <tmux-name> <cwd> [-- claude-args...]}"
  shift 2
  # Skip a leading -- separator if present
  if [ "${1:-}" = "--" ]; then shift; fi
  local extra_args=("$@")

  # Capture the invocation for the reproduce line
  local original_argv=("$tmux_name" "$working_dir")
  if [ "${#extra_args[@]}" -gt 0 ]; then
    original_argv+=("--" "${extra_args[@]}")
  fi

  # Resolve plugin root (three levels above scripts/)
  local plugin_dir
  plugin_dir="$(cd "$SCRIPT_DIR/../../.." && pwd)"

  # Resolve cwd to absolute, follow symlinks
  if [ ! -d "$working_dir" ]; then
    echo "Error: cwd '$working_dir' does not exist" >&2
    return 1
  fi
  working_dir="$(cd "$working_dir" && pwd -P)"

  # Consent check
  local consent_file="$HOME/.claude/.claude-session-driver-consent"
  if [ ! -f "$consent_file" ]; then
    cat >&2 <<EOF
Error: claude-session-driver requires one-time consent before launching workers.
Run: $CSD_PATH grant-consent
EOF
    return 1
  fi

  # Generate session ID
  local session_id
  session_id=$(uuidgen | tr '[:upper:]' '[:lower:]')

  mkdir -p /tmp/claude-workers /tmp/claude-workers/bin

  # Write meta (includes cwd and invocation for reproduce)
  local invocation_json
  invocation_json=$(printf '%s\n' "${original_argv[@]}" | jq -R . | jq -s .)
  jq -n \
    --arg tmux_name "$tmux_name" \
    --arg session_id "$session_id" \
    --arg cwd "$working_dir" \
    --arg started_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --argjson invocation "$invocation_json" \
    '{tmux_name: $tmux_name, session_id: $session_id, cwd: $cwd, started_at: $started_at, invocation: $invocation}' \
    > "/tmp/claude-workers/${session_id}.meta"

  # Collision check
  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "Error: tmux session '$tmux_name' already exists" >&2
    rm -f "/tmp/claude-workers/${session_id}.meta"
    return 1
  fi

  # Start tmux. Allow override of the claude binary via CSD_CLAUDE_BIN for tests.
  local claude_bin="${CSD_CLAUDE_BIN:-claude}"
  tmux new-session -d -s "$tmux_name" -c "$working_dir" \
    -e "CLAUDE_CODE_SSE_PORT=" \
    -e "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=" \
    "$claude_bin" --session-id "$session_id" --plugin-dir "$plugin_dir" \
      --settings '{"skipDangerousModePermissionPrompt":true}' \
      --dangerously-skip-permissions \
      --disallowed-tools AskUserQuestion \
      "${extra_args[@]+"${extra_args[@]}"}"

  # Trust-dialog accept (content-aware) — same logic as legacy launch-worker.sh
  local trust_deadline=$((SECONDS + 5))
  while [ "$SECONDS" -lt "$trust_deadline" ]; do
    local pane_text
    pane_text=$(tmux capture-pane -t "$tmux_name" -p 2>/dev/null || true)
    if echo "$pane_text" | grep -qF "trust this folder"; then
      tmux send-keys -t "$tmux_name" Enter
      break
    fi
    if [ -f "/tmp/claude-workers/${session_id}.events.jsonl" ] \
       && grep -q '"event":"session_start"' "/tmp/claude-workers/${session_id}.events.jsonl" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  # Wait for session_start (reuse cmd_wait_for_event-like inline logic)
  local event_file="/tmp/claude-workers/${session_id}.events.jsonl"
  local deadline=$((SECONDS + 30))
  local started=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -f "$event_file" ] && grep -q '"event":"session_start"' "$event_file"; then
      started=1
      break
    fi
    sleep 0.5
  done

  if [ "$started" -eq 0 ]; then
    local pane
    pane=$(tmux capture-pane -t "$tmux_name" -p 2>/dev/null | sed -e 's/[[:space:]]*$//' -e '/^$/d' | tail -20 || true)
    {
      echo "Error: Worker session failed to start within 30 seconds"
      if [ -n "$pane" ]; then
        echo ""
        echo "Last visible content in the worker pane:"
        echo "----------"
        echo "$pane"
        echo "----------"
      fi
    } >&2
    tmux kill-session -t "$tmux_name" 2>/dev/null || true
    rm -f "/tmp/claude-workers/${session_id}.meta" "$event_file"
    return 1
  fi

  # Write the shim
  local shim_path="/tmp/claude-workers/bin/$tmux_name"
  cat > "$shim_path" <<EOF
#!/bin/bash
exec "$CSD_PATH" --worker "$tmux_name" "\$@"
EOF
  chmod +x "$shim_path"

  # Output: shim path on stdout, panel on stderr
  echo "$shim_path"
  {
    echo "Worker launched."
    echo "  tmux:       $tmux_name"
    echo "  session_id: $session_id"
    echo "  events:     $event_file"
    echo "  reproduce:  $CSD_PATH launch ${original_argv[*]}"
  } >&2
}
```

Wire into dispatch — add `launch)  cmd_launch "$@" ;;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-launch.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-launch.sh
git commit -m "csd: implement launch with shim generation"
```

---

## Task 13: csd stop

**Files:**
- Modify: `skills/driving-claude-code-sessions/scripts/csd`
- Test: `tests/test-csd-stop.sh`

Port from `scripts/stop-worker.sh`. Cleanup now includes the shim file.

- [ ] **Step 1: Write the failing test**

Create `tests/test-csd-stop.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

TMUX_NAME="test-csd-stop"
SID="test-stop-001"
cleanup() {
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  rm -f "$WDIR/$SID.meta" "$WDIR/$SID.events.jsonl" "$WDIR/bin/$TMUX_NAME"
}
trap cleanup EXIT
cleanup
mkdir -p "$WDIR" "$WDIR/bin"

# Set up a worker: tmux session, meta, events, shim
tmux new-session -d -s "$TMUX_NAME" 'sleep 60'
echo "{\"tmux_name\":\"$TMUX_NAME\",\"session_id\":\"$SID\",\"cwd\":\"/tmp\"}" > "$WDIR/$SID.meta"
echo '{"event":"stop"}' > "$WDIR/$SID.events.jsonl"
echo '#!/bin/bash' > "$WDIR/bin/$TMUX_NAME"
chmod +x "$WDIR/bin/$TMUX_NAME"

bash "$CSD" --worker "$TMUX_NAME" stop >/dev/null

tmux has-session -t "$TMUX_NAME" 2>/dev/null && fail "tmux still alive" "$(tmux ls)" || pass "tmux killed"
[ ! -f "$WDIR/$SID.meta" ] && pass "meta removed" || fail "meta" "still present"
[ ! -f "$WDIR/$SID.events.jsonl" ] && pass "events removed" || fail "events" "still present"
[ ! -f "$WDIR/bin/$TMUX_NAME" ] && pass "shim removed" || fail "shim" "still present"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-csd-stop.sh`
Expected: FAIL — stop is a stub.

- [ ] **Step 3: Implement stop**

Add to `scripts/csd`:

```bash
cmd_stop() {
  local sid tmux_name
  sid=$(resolve_session "$WORKER")
  tmux_name=$(jq -r '.tmux_name' "/tmp/claude-workers/${sid}.meta")

  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    tmux send-keys -t "$tmux_name" -l '/exit'
    tmux send-keys -t "$tmux_name" Enter

    # Wait up to 10s for session_end. Reuse wait-for-event-style inline logic
    # but only watch for session_end (stop is too lax here).
    local event_file="/tmp/claude-workers/${sid}.events.jsonl"
    local deadline=$((SECONDS + 10))
    while [ "$SECONDS" -lt "$deadline" ]; do
      if [ -f "$event_file" ] && grep -q '"event":"session_end"' "$event_file"; then
        sleep 1
        break
      fi
      sleep 0.5
    done

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
      tmux kill-session -t "$tmux_name"
    fi
  fi

  rm -f "/tmp/claude-workers/${sid}.events.jsonl"
  rm -f "/tmp/claude-workers/${sid}.meta"
  rm -f "/tmp/claude-workers/bin/${tmux_name}"

  echo "Worker $tmux_name ($sid) stopped and cleaned up"
}
```

Wire into dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-csd-stop.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/driving-claude-code-sessions/scripts/csd tests/test-csd-stop.sh
git commit -m "csd: implement stop with shim cleanup"
```

---

## Task 14: Integration test through the shim

**Files:**
- Test: `tests/test-csd-integration.sh`

End-to-end: launch a worker (via the fake claude stub from Task 12), then drive it entirely through the shim. Verifies the shim correctly bakes in `--worker`.

- [ ] **Step 1: Write the test**

Create `tests/test-csd-integration.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

TMUX_NAME="test-csd-int-$$"
FAKE_HOME=$(mktemp -d)
mkdir -p "$FAKE_HOME/.claude"
touch "$FAKE_HOME/.claude/.claude-session-driver-consent"

cleanup() {
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  rm -rf "$FAKE_HOME"
  rm -f /tmp/claude-workers/bin/"$TMUX_NAME"
  for f in /tmp/claude-workers/*.meta; do
    [ -f "$f" ] || continue
    if jq -e --arg n "$TMUX_NAME" '.tmux_name == $n' "$f" >/dev/null 2>&1; then
      sid=$(jq -r '.session_id' "$f")
      rm -f "$f" "/tmp/claude-workers/${sid}.events.jsonl"
    fi
  done
}
trap cleanup EXIT
cleanup

FAKE_CLAUDE=$(mktemp)
cat > "$FAKE_CLAUDE" <<'BASH'
#!/bin/bash
SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) SID="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p /tmp/claude-workers
echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"event\":\"session_start\",\"cwd\":\"$PWD\"}" \
  > "/tmp/claude-workers/${SID}.events.jsonl"
exec sleep 60
BASH
chmod +x "$FAKE_CLAUDE"

SHIM=$(CSD_CLAUDE_BIN="$FAKE_CLAUDE" HOME="$FAKE_HOME" \
       bash "$CSD" launch "$TMUX_NAME" /tmp 2>/dev/null)
[ -x "$SHIM" ] && pass "launch returned executable shim" || fail "shim" "not executable: $SHIM"

# status via shim
STATUS=$("$SHIM" status)
[ "$STATUS" = "idle" ] && pass "shim status = idle" || fail "status" "got $STATUS"

# session-id via shim matches meta
SID_VIA_SHIM=$("$SHIM" session-id)
META=$(ls /tmp/claude-workers/*.meta | xargs grep -l "$TMUX_NAME" | head -1)
SID_IN_META=$(jq -r '.session_id' "$META")
[ "$SID_VIA_SHIM" = "$SID_IN_META" ] && pass "session-id matches" || fail "sid" "shim=$SID_VIA_SHIM meta=$SID_IN_META"

# read-events via shim
EVENTS=$("$SHIM" read-events)
echo "$EVENTS" | grep -q session_start && pass "read-events returns session_start" || fail "read-events" "$EVENTS"

# stop via shim removes everything
"$SHIM" stop >/dev/null
[ ! -f "$SHIM" ] && pass "stop removed shim" || fail "shim cleanup" "still present"
[ ! -f "$META" ] && pass "stop removed meta" || fail "meta cleanup" "still present"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
```

- [ ] **Step 2: Run the test**

Run: `bash tests/test-csd-integration.sh`
Expected: PASS — uses the implementations from Tasks 1–13.

- [ ] **Step 3: Commit**

```bash
git add tests/test-csd-integration.sh
git commit -m "csd: end-to-end integration test through the shim"
```

---

## Task 15: Delete old scripts and tests

**Files:**
- Delete: `skills/driving-claude-code-sessions/scripts/{launch-worker,converse,send-prompt,wait-for-event,read-events,read-turn,status,stop-worker,handoff,list-workers,current,grant-consent}.sh`
- Delete: `tests/{test-launch-worker,test-send-prompt,test-wait-for-event,test-read-events,test-integration}.sh`
- Keep: `tests/test-emit-event.sh`, `tests/helpers/timestamp-stdin.py`

- [ ] **Step 1: Verify nothing in the new csd uses the old script paths**

Run:
```bash
grep -rn "scripts/launch-worker\|scripts/converse\|scripts/send-prompt\|scripts/wait-for-event\|scripts/read-events\|scripts/read-turn\|scripts/status\|scripts/stop-worker\|scripts/handoff\|scripts/list-workers\|scripts/current\|scripts/grant-consent" \
  skills/ tests/test-csd-*.sh
```
Expected: no matches.

- [ ] **Step 2: Delete the old script files**

```bash
cd skills/driving-claude-code-sessions/scripts
rm -f launch-worker.sh converse.sh send-prompt.sh wait-for-event.sh \
      read-events.sh read-turn.sh status.sh stop-worker.sh handoff.sh \
      list-workers.sh current.sh grant-consent.sh
```

- [ ] **Step 3: Delete the old test files**

```bash
cd ../../..  # back to plugin root
rm -f tests/test-launch-worker.sh tests/test-send-prompt.sh \
      tests/test-wait-for-event.sh tests/test-read-events.sh \
      tests/test-integration.sh
```

- [ ] **Step 4: Run the full new test suite**

```bash
for t in tests/test-csd-*.sh tests/test-emit-event.sh; do
  echo "=== $t ==="
  bash "$t" || { echo "FAILED: $t"; exit 1; }
done
```
Expected: every test passes.

- [ ] **Step 5: Commit**

```bash
git add -A skills/driving-claude-code-sessions/scripts tests/
git commit -m "csd: drop legacy scripts and tests in favor of unified CLI"
```

---

## Task 16: Rewrite SKILL.md

**Files:**
- Rewrite: `skills/driving-claude-code-sessions/SKILL.md`

The new SKILL.md teaches csd exclusively. Drops the "prepend absolute skill path on every call" preamble (only `csd launch`/`list`/`grant-consent` need the skill path). Drops the per-script reference table. The events vocabulary becomes a small footnote about `read-events --type`.

- [ ] **Step 1: Replace SKILL.md content**

Overwrite `skills/driving-claude-code-sessions/SKILL.md` with:

```markdown
---
name: driving-claude-code-sessions
description: Use when acting as a project manager that delegates tasks to other Claude Code sessions - launch workers, assign them work, monitor progress, review their tool calls, and collect results
---

# Driving Claude Code Sessions

## Overview

You can launch other Claude Code sessions as "workers" in tmux, send them prompts, wait for them to finish, read their output, and hand them off to a human. Workers run with `--dangerously-skip-permissions`, so they execute tool calls without prompting. A plugin (claude-session-driver) emits lifecycle events to a JSONL file so the controller can observe what the worker is doing.

All operations go through a single CLI: `csd`. After launching a worker, the controller receives a **shim path** at `/tmp/claude-workers/bin/<tmux-name>` that bakes in the worker handle. Every per-worker operation goes through that path — no environment variables to remember, no absolute skill path to prepend.

## Prerequisites

- **tmux**
- **jq**
- **claude** CLI

## Setup

The CLI lives at `<skill>/scripts/csd`. Three top-level subcommands need the skill path:

- `csd launch <tmux-name> <cwd> [-- claude-args...]` — bootstrap a worker
- `csd list [--all]` — enumerate workers
- `csd grant-consent` — one-time consent for `--dangerously-skip-permissions`

Once a worker is launched, capture the shim path it prints to stdout and use it for everything else.

```bash
SKILL=/abs/path/to/skill/scripts
$SKILL/csd grant-consent          # one-time per machine
WORKER=$($SKILL/csd launch my-task /path/to/project)
# $WORKER is now /tmp/claude-workers/bin/my-task
```

The shim path is deterministic — if you know the tmux name, the path is `/tmp/claude-workers/bin/<tmux-name>`. You don't need to keep the variable around if the name is memorable.

## Workflow

### 1. Launch

```bash
WORKER=$($SKILL/csd launch my-task /path/to/project)
```

`csd launch`:
- Writes a meta file and a 3-line shim at `/tmp/claude-workers/bin/my-task`
- Starts tmux + claude with the plugin loaded
- Waits up to 30s for `session_start`
- Prints the shim path on stdout (one line)
- Prints a "Worker launched" panel on stderr including a `reproduce:` line with the exact relaunch command

Pass claude CLI args after a `--` separator:
```bash
WORKER=$($SKILL/csd launch my-task /path/to/project -- --model sonnet)
```

### 2. Converse (the typical case)

```bash
RESPONSE=$($WORKER converse "Refactor the auth module" 300)
echo "$RESPONSE"
```

`converse` sends the prompt, waits for the worker to finish, and returns the final assistant text. For tool-heavy turns where the bare text strips the interesting part, use `--with-turn` to get the full markdown:

```bash
TURN=$($WORKER converse --with-turn "Run the failing tests" 600)
```

Multi-turn just works — the wait tracks turn boundaries automatically:

```bash
R1=$($WORKER converse "Write tests for the auth module" 300)
R2=$($WORKER converse "Add edge cases for expired tokens" 300)
```

### 3. Lower-level control

If you need to drive the worker more directly:

```bash
$WORKER send "Refactor the auth module"     # send without waiting
$WORKER wait-for-turn 300                    # block until stop or session_end
$WORKER status                               # idle | working | terminated | gone
$WORKER read-turn                            # last turn as markdown
$WORKER read-turn --full                     # with complete tool results
```

### 4. Watching what the worker does

Every tool call emits a `pre_tool_use` event with the tool name and input. Tail the event stream to watch in real time:

```bash
$WORKER read-events --follow &
MONITOR_PID=$!
# ... do other work ...
kill $MONITOR_PID
```

Or pull events after the fact:

```bash
$WORKER read-events                # all events
$WORKER read-events --last 5
$WORKER read-events --type pre_tool_use
```

`--type` accepts one of: `session_start`, `user_prompt_submit`, `pre_tool_use`, `stop`, `session_end`. Unknown event names fail fast.

If you see something you don't want, stop the worker:

```bash
$WORKER stop
```

### 5. Stop and clean up

```bash
$WORKER stop
```

Sends `/exit`, waits up to 10s for `session_end`, kills the tmux session if still running, and removes the meta, events, and shim files.

### 6. Hand off to a human

```bash
$WORKER handoff
```

Prints attach instructions for a human to take over the tmux session.

## Reference

```
csd launch <tmux-name> <cwd> [-- claude-args...]
csd list [--all]
csd grant-consent

$WORKER converse [--with-turn] <prompt> [timeout=120]
$WORKER send <prompt>
$WORKER wait-for-turn [timeout=60]
$WORKER status
$WORKER read-events [--last N] [--type T] [--follow]
$WORKER read-turn [--full]
$WORKER stop
$WORKER handoff
$WORKER session-id
$WORKER events-file
```

Run `csd help` for the same surface.

## Common Patterns

### Fan-Out: Multiple Workers in Parallel

```bash
W1=$($SKILL/csd launch worker-api ~/proj)
W2=$($SKILL/csd launch worker-ui ~/proj)

$W1 send "Add pagination to /users"
$W2 send "Add a loading spinner to the user list"

$W1 wait-for-turn 600
$W2 wait-for-turn 600

$W1 stop
$W2 stop
```

### Pipeline: Worker A produces, Worker B consumes

```bash
W1=$($SKILL/csd launch spec ~/proj)
$W1 converse "Write an OpenAPI spec for /users to /tmp/api.yaml" 300
$W1 stop

W2=$($SKILL/csd launch impl ~/proj)
$W2 converse "Implement the endpoint defined in /tmp/api.yaml" 600
$W2 stop
```

## Edge Cases

### Worker crashes mid-turn

`wait-for-turn` matches `stop` OR `session_end`, so it returns when the worker dies. Call `$WORKER status` afterward: if it's `gone`, the worker crashed.

### Lost the shim path

If you know the tmux name, the path is `/tmp/claude-workers/bin/<tmux-name>`. If you don't, `csd list` enumerates everything.

### Long prompts

`send` uses bracketed-paste, which handles multi-line and special characters. For prompts in the tens-of-KB range, write to a file and tell the worker to read it:

```bash
echo "Long instructions..." > /tmp/instructions.txt
$WORKER send "Read /tmp/instructions.txt and follow it"
```

## Important Notes

- **One controller per worker.** Two controllers driving the same tmux session will collide.
- **Workers don't share state with the controller** except via files on disk and the event stream.
- **Shim paths bake in absolute skill paths.** A plugin reinstall at a new location breaks live workers; relaunch them.
```

- [ ] **Step 2: Verify the new SKILL.md doesn't reference any deleted script**

```bash
grep -nE 'launch-worker\.sh|converse\.sh|send-prompt\.sh|wait-for-event\.sh|read-events\.sh|read-turn\.sh|status\.sh|stop-worker\.sh|handoff\.sh|list-workers\.sh|current\.sh|grant-consent\.sh' \
  skills/driving-claude-code-sessions/SKILL.md
```
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add skills/driving-claude-code-sessions/SKILL.md
git commit -m "csd: rewrite SKILL.md to teach the unified CLI"
```

---

## Task 17: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read the existing CHANGELOG to match its style**

```bash
head -30 CHANGELOG.md
```

- [ ] **Step 2: Prepend a new entry**

Open `CHANGELOG.md` and add a new entry at the top (under any existing header). Match the format used by previous entries. Body:

```markdown
## 3.0.0 — 2026-05-18

### Breaking changes
- Replaced 12 per-operation scripts with a single `csd` CLI at
  `skills/driving-claude-code-sessions/scripts/csd`. The old scripts
  (`launch-worker.sh`, `converse.sh`, `send-prompt.sh`,
  `wait-for-event.sh`, `read-events.sh`, `read-turn.sh`, `status.sh`,
  `stop-worker.sh`, `handoff.sh`, `list-workers.sh`, `current.sh`,
  `grant-consent.sh`) are removed.
- `csd launch` writes a per-worker shim at
  `/tmp/claude-workers/bin/<tmux-name>` and prints that path on stdout.
  All per-worker operations go through the shim — see the rewritten
  SKILL.md for the new workflow.
- `wait-for-event` is replaced by `wait-for-turn`, which matches `stop`
  OR `session_end` (the only two events that signal "controller's
  turn"). Raw-event waits are no longer supported; use
  `$WORKER read-events --type T --follow` if you need ambient
  observation.
- `current` is removed — it returned "most-recently-touched meta file,"
  which silently misleads in multi-worker controllers. Use `csd list`.
- The meta file format gains `cwd` (was already present) and
  `invocation` (new) fields. Old workers from prior versions are not
  upgraded; relaunch them.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "csd: 3.0.0 changelog entry"
```

---

## Self-Review

I ran the self-review checklist after writing the plan:

**1. Spec coverage:**
- Single skill-path entrypoint `csd`: Tasks 1–13 build it.
- Top-level subcommands launch/list/grant-consent: Tasks 12, 3, 2.
- Per-worker subcommands: Tasks 4–11, 13.
- `wait-for-turn` matches stop OR session_end: Task 7.
- Shim at `/tmp/claude-workers/bin/<tmux-name>`: Task 12 (creation), Task 13 (cleanup), Task 14 (verified through end-to-end).
- Launch output (shim path on stdout, panel on stderr, reproduce line): Task 12.
- `_lib.sh` kept as-is: not modified by any task.
- Old scripts and tests deleted: Task 15.
- SKILL.md rewrite: Task 16.
- CHANGELOG: Task 17.
- `--worker` flag rejected on top-level, required on per-worker: Task 1.
- Event validation on `read-events --type`: Task 6.

**2. Placeholder scan:** All tasks have concrete code, exact paths, expected outputs, and runnable commands. No TBDs.

**3. Type consistency:**
- Bash function names use `cmd_<subcommand>` consistently (with underscores: `cmd_wait_for_turn`, not `cmd_wait-for-turn`). Verified across all tasks.
- `$WORKER` variable name used consistently in plan prose and SKILL.md.
- Meta file fields: `tmux_name`, `session_id`, `cwd`, `started_at`, `invocation`. Consistent across tasks 3, 5, 8, 10, 12.
- Shim path format `/tmp/claude-workers/bin/<tmux-name>` consistent.
- `CSD_CLAUDE_BIN` env var name consistent between Tasks 12 and 14.

No issues found.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-csd-cli-redesign.md`. The user has already chosen subagent-driven execution.
