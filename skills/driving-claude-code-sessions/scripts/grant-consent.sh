#!/bin/bash
set -euo pipefail

# Interactive one-time consent flow for claude-session-driver.
#
# Workers run with --dangerously-skip-permissions. There is no per-call
# approval gate — Claude Code bypasses its permission system entirely under
# that flag, so the worker executes tool calls without prompting. The plugin
# emits lifecycle events to a JSONL file (including pre_tool_use, so you can
# watch what the worker is doing) but does not block tool calls on a
# controller decision.
#
# Because of that, the user should affirmatively accept the bypass mode once
# before any worker is launched. After acceptance, a dotfile is written to
# ~/.claude/.claude-session-driver-consent and launch-worker.sh stops asking.
#
# This script must be run interactively (from a real terminal). The intended
# use case for launch-worker.sh is invocation from inside another claude
# session via the Bash tool — stdin there is not a TTY, so the prompt can't
# happen there. Run this script once per machine; thereafter, launch-worker
# proceeds without prompting.
#
# Usage: bash grant-consent.sh

CONSENT_FILE="$HOME/.claude/.claude-session-driver-consent"

if [ -f "$CONSENT_FILE" ]; then
  echo "Consent already on file at $CONSENT_FILE"
  echo "Nothing to do. Delete that file if you want to re-grant consent."
  exit 0
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
  cat >&2 <<EOF
Error: grant-consent.sh must be run from an interactive terminal.

This script asks you a yes/no question about whether you accept the plugin's
use of --dangerously-skip-permissions. It can't run when stdin or stdout is
piped or redirected.

Open a real terminal and run:
    bash $0
EOF
  exit 1
fi

cat <<EOF

claude-session-driver — one-time consent
========================================

This plugin spawns Claude Code workers with --dangerously-skip-permissions.

Workers will not display the normal permission dialog before each tool call,
and the plugin does not gate tool calls either. The PreToolUse hook records
a pre_tool_use event to the worker's event stream so a controller can watch
what's happening, but the tool runs regardless of what any controller does.

In practice this means a worker will execute whatever tool calls the model
decides to make in response to the prompts you send it. You are responsible
for the prompts you give workers and for the actions those workers take.

To monitor a running worker, tail its event file:

    tail -f /tmp/claude-workers/<session_id>.events.jsonl

To stop a worker, use scripts/stop-worker.sh.

This consent is recorded in

    $CONSENT_FILE

and you will not be asked again. To revoke consent, delete that file.

EOF

printf 'Type "yes" to accept and continue: '
read -r CONSENT_REPLY

case "$CONSENT_REPLY" in
  yes|YES|Yes)
    mkdir -p "$(dirname "$CONSENT_FILE")"
    printf 'Consent granted at %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$CONSENT_FILE"
    echo ""
    echo "Consent recorded. You can now launch workers from any context"
    echo "(including the Bash tool inside another Claude session)."
    ;;
  *)
    echo ""
    echo "Consent not granted. No file was written. Re-run this script when"
    echo "you're ready to accept."
    exit 1
    ;;
esac
