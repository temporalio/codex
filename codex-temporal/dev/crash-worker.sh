#!/usr/bin/env bash
# Kill the worker in the middle of a turn and show the turn finish on a fresh one.
#
# No tool call here, so this isolates two claims: the prompt is not asked twice, and Temporal
# re-drove the turn. The second one needs the attempt number, because a turn that quietly finished
# before the kill would satisfy everything else.
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

require_temporal
session=crash-worker-$$
token=CRASHW-$$
say "== session $session"

start_worker
promptId=$(tsx submit.mts "$session" \
  "Count from 1 to 2000, one number per line, then reply with the single word CHARLIE. ($token)" \
  | awk '{print $2}')
say "prompt $promptId"

found=$(wait_rollout "$token") || die "no rollout for $token in 120s. Worker log: $LOG_DIR/worker.log"
path=$(printf '%s' "$found" | json_get path)
thread=$(printf '%s' "$found" | json_get threadId)
remember_thread "$session" "$thread"
say "thread $thread"

turn_in_flight "$session" "$promptId" \
  || die "the turn is not in flight any more, so a kill would prove nothing. Try a longer prompt."

before=$(python3 "$DEV_DIR/count-prompt.py" "$path" "$token")
say "before the kill: $before"
say "SIGKILL worker $(read_pid worker)"
stop_tree worker -KILL

# The activity has a 30s heartbeat timeout, so nothing can be re-driven before it lapses.
say "waiting 35s for the heartbeat timeout to lapse"
sleep 35
start_worker

for _ in $(seq 200); do
  state=$(tsx state.mts "$session" 2>/dev/null) || { sleep 2; continue; }
  if printf '%s' "$state" | python3 "$DEV_DIR/finished.py" "$promptId"; then break; fi
  sleep 2
done

after=$(python3 "$DEV_DIR/count-prompt.py" "$path" "$token")
attempt=$(activity_attempt "$session")
say "after recovery:  $after"
say "activity attempt: $attempt"

fail=0
[ "$(printf '%s' "$before" | json_get prompts)" = 1 ] || { say "FAIL: prompt not recorded once before the kill"; fail=1; }
[ "$(printf '%s' "$after" | json_get prompts)" = 1 ] || { say "FAIL: the prompt was asked more than once"; fail=1; }
[ "${attempt:-0}" -ge 2 ] || { say "FAIL: activity finished on attempt $attempt, so the turn was never re-driven"; fail=1; }
printf '%s' "$after" | grep -q CHARLIE || { say "FAIL: no answer in the rollout"; fail=1; }
if [ "$fail" = 0 ]; then say "PASS: one prompt, re-driven on attempt $attempt, turn finished."; fi
exit "$fail"
