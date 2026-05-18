#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=/tmp/claude-workers

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

TMUX_NAME="test-csd-converse"
SID="test-conv-001"

# Declare cleanup before first use; FAKE_HOME/LOG_DIR/LOG set after cleanup runs
FAKE_HOME=""
cleanup() {
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null || true
  [ -n "$FAKE_HOME" ] && rm -rf "$FAKE_HOME"
  rm -f "$WDIR/$SID.meta" "$WDIR/$SID.events.jsonl"
}
trap cleanup EXIT
cleanup

# Create fresh temp dir after cleanup so it isn't immediately removed
FAKE_HOME=$(mktemp -d)
# Resolve through symlinks so macOS symlinked temp dirs don't cause path mismatch
FAKE_HOME=$(cd "$FAKE_HOME" && pwd -P)
CWD="$FAKE_HOME/proj"
mkdir -p "$CWD"
CWD=$(cd "$CWD" && pwd -P)
ENC=$(echo "$CWD" | sed 's|/|-|g')
LOG_DIR="$FAKE_HOME/.claude/projects/$ENC"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$SID.jsonl"
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
