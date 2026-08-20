#!/usr/bin/env bash
# Summarize the thread's rollout: prompts, tool-call balance, last answer.
#
# This reads Codex's own log off disk, so it works with no worker and no Temporal running. That is
# the point: after killing a worker, the rollout is the only honest witness left.
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

arg=${1:-dev}
thread=$(recall_thread "$arg" || true)
[ -n "$thread" ] || thread=$arg   # accept a thread id directly

tsx inspect.mts "$thread"
