#!/bin/bash
set -euo pipefail

# Prints the current state of a worker. Useful to check whether it's safe to
# send another prompt without races (e.g. when using send-prompt.sh +
# wait-for-event.sh directly rather than the higher-level converse.sh).
#
# States, in order of precedence:
#   gone        - tmux session no longer exists (worker crashed or was killed
#                 outside stop-worker.sh)
#   terminated  - last event was session_end; worker has exited cleanly
#   working     - worker is processing a prompt (last event is
#                 user_prompt_submit or pre_tool_use)
#   idle        - last event is stop or session_start; safe to send the next
#                 prompt
#   unknown     - no events file yet; worker may not have started
#
# Usage: status.sh <session-id-or-tmux-name>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

ID_OR_NAME="${1:?Usage: status.sh <session-id-or-tmux-name>}"
SESSION_ID=$(resolve_session "$ID_OR_NAME")

META_FILE="/tmp/claude-workers/${SESSION_ID}.meta"
EVENT_FILE="/tmp/claude-workers/${SESSION_ID}.events.jsonl"

TMUX_NAME=$(jq -r '.tmux_name' "$META_FILE")

# tmux liveness wins — if the session is gone, nothing else matters.
if ! tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
  echo "gone"
  exit 0
fi

if [ ! -f "$EVENT_FILE" ]; then
  echo "unknown"
  exit 0
fi

LAST_EVENT=$(tail -1 "$EVENT_FILE" | jq -r '.event' 2>/dev/null || echo "")

case "$LAST_EVENT" in
  session_end)
    echo "terminated" ;;
  user_prompt_submit|pre_tool_use)
    echo "working" ;;
  stop|session_start)
    echo "idle" ;;
  *)
    echo "unknown" ;;
esac
