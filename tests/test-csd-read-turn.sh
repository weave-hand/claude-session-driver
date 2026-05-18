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
# Resolve symlinks so the encoded path matches what cmd_read_turn will produce
# (cmd_read_turn calls cd "$cwd" && pwd -P before encoding).
CWD=$(cd "$CWD" && pwd -P)
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
