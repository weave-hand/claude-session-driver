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
