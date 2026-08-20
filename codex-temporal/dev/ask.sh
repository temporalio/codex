#!/usr/bin/env bash
# Submit a prompt to a thread and wait for the answer.
#   dev/ask.sh "Reply with the single word BRAVO."
#   dev/ask.sh my-session "and what did you just say?"
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

if [ $# -eq 1 ]; then session=dev; text=$1; else session=${1:?session}; text=${2:?prompt}; fi
require_temporal
timeout=${ASK_TIMEOUT:-600}

promptId=$(tsx submit.mts "$session" "$text" | awk '{print $2}')
say "session $session   prompt $promptId"

deadline=$((SECONDS + timeout))
while [ "$SECONDS" -lt "$deadline" ]; do
  if state=$(tsx state.mts "$session" 2>/dev/null); then
    remember_thread "$session" "$(printf '%s' "$state" | json_get threadId)"
    if printf '%s' "$state" | python3 "$DEV_DIR/finished.py" "$promptId"; then exit 0; fi
  fi
  sleep 2
done
die "no answer in ${timeout}s for prompt $promptId. Worker log: $LOG_DIR/worker.log"
