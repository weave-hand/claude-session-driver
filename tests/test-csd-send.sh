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
