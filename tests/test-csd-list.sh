#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSD="$SCRIPT_DIR/../skills/driving-claude-code-sessions/scripts/csd"
WDIR=$(mktemp -d)
export CSD_WORKER_DIR="$WDIR"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1 - $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  rm -rf "$WDIR"
  tmux kill-session -t test-list-alive 2>/dev/null || true
}
trap cleanup EXIT
mkdir -p "$WDIR/bin"

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
