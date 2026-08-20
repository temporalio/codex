# Shared wiring for the dev stack. Sourced, never run.
#
# Two rules hold this together. Ports and state live off the defaults, so this cannot disturb a
# Temporal or a Codex you already run. And every process we start is tracked by pid, so nothing
# here ever matches on a command line: a broad pkill would take down another session's worker.

# shellcheck shell=bash

DEV_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd -- "$DEV_DIR/.." && pwd)
REPO_DIR=$(cd -- "$PKG_DIR/.." && pwd)

STATE_DIR=${CODEX_TEMPORAL_DEV_DIR:-/tmp/codex-temporal-dev}
PID_DIR="$STATE_DIR/pids"
LOG_DIR="$STATE_DIR/logs"
THREAD_DIR="$STATE_DIR/threads"

TEMPORAL_PORT=${TEMPORAL_PORT:-7244}
TEMPORAL_UI_PORT=${TEMPORAL_UI_PORT:-8244}

export TEMPORAL_ADDRESS=${TEMPORAL_ADDRESS:-127.0.0.1:$TEMPORAL_PORT}
export TEMPORAL_NAMESPACE=${TEMPORAL_NAMESPACE:-default}
export CODEX_TEMPORAL_TASK_QUEUE=${CODEX_TEMPORAL_TASK_QUEUE:-codex-thread-dev}

# The worker needs a build from this fork, because it calls `--continue`.
export CODEX_PATH=${CODEX_PATH:-$REPO_DIR/codex-rs/target/debug/codex}
# Tools run here, so keep them out of the repo.
export CODEX_PROJECT_DIR=${CODEX_PROJECT_DIR:-$STATE_DIR/work}
export CODEX_SANDBOX=${CODEX_SANDBOX:-workspace-write}

mkdir -p "$PID_DIR" "$LOG_DIR" "$THREAD_DIR" "$CODEX_PROJECT_DIR"

say() { printf '%s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

port_taken() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }

record_pid() { printf '%s\n' "$2" >"$PID_DIR/$1.pid"; }
read_pid() { cat "$PID_DIR/$1.pid" 2>/dev/null || true; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# Depth-first so children are named before their parent. Only ever called on a pid we recorded,
# which is what keeps another session's tree out of reach.
descendants() {
  local kid
  for kid in $(pgrep -P "$1" 2>/dev/null); do
    descendants "$kid"
    printf '%s\n' "$kid"
  done
}

# Stop a recorded process and its children. `tsx` runs the worker in a child, so the pid we own is
# not always the node process doing the work.
stop_tree() {
  local name=$1 sig=${2:--TERM} pid kid
  pid=$(read_pid "$name")
  if alive "$pid"; then
    for kid in $(descendants "$pid"); do kill "$sig" "$kid" 2>/dev/null || true; done
    kill "$sig" "$pid" 2>/dev/null || true
    local i
    for i in $(seq 40); do alive "$pid" || break; sleep 0.25; done
  fi
  rm -f "$PID_DIR/$name.pid"
}

require_temporal() {
  port_taken "$TEMPORAL_PORT" || die "no Temporal on $TEMPORAL_ADDRESS. Run dev/temporal.sh first."
}

start_worker() {
  stop_tree worker -KILL
  : >"$LOG_DIR/worker.log"
  "$DEV_DIR/worker.sh" >>"$LOG_DIR/worker.log" 2>&1 &
  record_pid worker $!
  local i
  for i in $(seq 60); do
    grep -q 'codex-temporal worker on' "$LOG_DIR/worker.log" 2>/dev/null && return 0
    sleep 0.5
  done
  say "worker did not come up; last lines:"; tail -5 "$LOG_DIR/worker.log" >&2
  return 1
}

tsx() { (cd "$PKG_DIR" && ./node_modules/.bin/tsx "$@"); }

# The thread id is Codex's, and it is the only way into the rollout once no worker is left to
# answer a query. Cache it the moment we see one.
remember_thread() {
  if [ -n "${2:-}" ] && [ "$2" != null ]; then printf '%s\n' "$2" >"$THREAD_DIR/$1"; fi
  return 0
}
recall_thread() { cat "$THREAD_DIR/$1" 2>/dev/null; }

# Find the rollout for a prompt while the turn is still running. Poll for the file rather than the
# workflow's thread id: the workflow only learns that from the activity's result, so it arrives too
# late to kill anything mid-turn.
wait_rollout() {
  local token=$1 tries=${2:-120} out
  local i
  for i in $(seq "$tries"); do
    if out=$(python3 "$DEV_DIR/find-rollout.py" "${CODEX_SESSIONS_DIR:-${CODEX_HOME:-$HOME/.codex}/sessions}" "$token" 2>/dev/null); then
      printf '%s\n' "$out"
      return 0
    fi
    sleep 1
  done
  return 1
}

# Refuse to kill anything unless the turn is genuinely in flight. A turn that already finished makes
# every later assertion pass for the wrong reason, which is the trap this whole check exists for.
turn_in_flight() {
  local session=$1 promptId=$2 state
  state=$(tsx state.mts "$session" 2>/dev/null) || return 1
  printf '%s' "$state" | python3 -c '
import json, sys
state = json.load(sys.stdin)
prompt = sys.argv[1]
running = (state.get("running") or {}).get("promptId")
done = (state.get("finished") or {}).get("promptId")
sys.exit(0 if running == prompt and done != prompt else 1)
' "$promptId"
}

# A 2 here means Temporal re-drove the turn. It is the one claim an early-finishing turn cannot fake.
activity_attempt() {
  temporal workflow show --workflow-id "codex-thread-$1" --output json 2>/dev/null \
    | python3 "$DEV_DIR/attempt.py"
}

json_get() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1]) if d.get(sys.argv[1]) is not None else "")' "$1"; }
