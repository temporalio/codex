#!/usr/bin/env bash
# The test worth running: kill the worker with one tool call settled and another in flight.
#
# It asserts the thing a durable executor has to get right. The finished tool keeps its recorded
# result and does not run again, so `a.txt` still holds one line afterwards. That needs the
# missing-output fix as well: without it, resuming a thread with a dangling custom tool call panics
# and the process sits on the thread's writer lock.
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

require_temporal
host="$(dirname "$CODEX_PATH")/codex-code-mode-host"
[ -x "$host" ] || die "no codex-code-mode-host at $host, so tool calls cannot run. See dev/setup.sh."

session=crash-tool-$$
token=CRASHT-$$
work=$CODEX_PROJECT_DIR
rm -f "$work/a.txt"
say "== session $session   work dir $work"

start_worker
promptId=$(tsx submit.mts "$session" \
  "Use the shell, one command at a time and in this order. First run: echo first >> a.txt
Wait for it to finish, then run: sleep 90
When both are done, reply with the single word DELTA. ($token)" | awk '{print $2}')
say "prompt $promptId"

found=$(wait_rollout "$token") || die "no rollout for $token in 120s. Worker log: $LOG_DIR/worker.log"
path=$(printf '%s' "$found" | json_get path)
thread=$(printf '%s' "$found" | json_get threadId)
remember_thread "$session" "$thread"
say "thread $thread"

# More tool calls than outputs means the first one settled and the second is still running. That is
# the only window where this test proves anything.
say "waiting for a tool call to be in flight"
for _ in $(seq 240); do
  now=$(python3 "$DEV_DIR/count-prompt.py" "$path" "$token")
  calls=$(printf '%s' "$now" | json_get toolCalls)
  outs=$(printf '%s' "$now" | json_get toolOutputs)
  if [ "${calls:-0}" -gt "${outs:-0}" ]; then break; fi
  sleep 1
done

before=$(python3 "$DEV_DIR/count-prompt.py" "$path" "$token")
lines_before=$(wc -l <"$work/a.txt" 2>/dev/null | tr -d ' ' || echo 0)
say "before the kill: $before   a.txt lines: $lines_before"
[ "$(printf '%s' "$before" | json_get toolCalls)" -gt "$(printf '%s' "$before" | json_get toolOutputs)" ] \
  || die "no tool call in flight, so the kill would prove nothing. Try again."
turn_in_flight "$session" "$promptId" || die "the turn is not in flight any more. Try again."

say "SIGKILL worker $(read_pid worker)"
stop_tree worker -KILL

say "waiting 35s for the heartbeat timeout to lapse"
sleep 35
start_worker

for _ in $(seq 250); do
  state=$(tsx state.mts "$session" 2>/dev/null) || { sleep 2; continue; }
  if printf '%s' "$state" | python3 "$DEV_DIR/finished.py" "$promptId"; then break; fi
  sleep 2
done

after=$(python3 "$DEV_DIR/count-prompt.py" "$path" "$token")
lines_after=$(wc -l <"$work/a.txt" 2>/dev/null | tr -d ' ' || echo 0)
attempt=$(activity_attempt "$session")
say "after recovery:  $after   a.txt lines: $lines_after"
say "activity attempt: $attempt"

fail=0
[ "$(printf '%s' "$after" | json_get prompts)" = 1 ] || { say "FAIL: the prompt was asked more than once"; fail=1; }
[ "${lines_after:-0}" -eq 1 ] || { say "FAIL: a.txt has $lines_after lines, so a settled tool ran again"; fail=1; }
[ "${attempt:-0}" -ge 2 ] || { say "FAIL: activity finished on attempt $attempt, so the turn was never re-driven"; fail=1; }
printf '%s' "$after" | grep -q DELTA || { say "FAIL: the turn did not finish"; fail=1; }
if [ "$fail" = 0 ]; then say "PASS: one prompt, the settled tool did not re-run, re-driven on attempt $attempt."; fi
exit "$fail"
