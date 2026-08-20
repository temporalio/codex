#!/usr/bin/env bash
# What the thread is doing, from the workflow. Needs a live worker, because a query needs a poller.
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

session=${1:-dev}
require_temporal
state=$(tsx state.mts "$session")
remember_thread "$session" "$(printf '%s' "$state" | json_get threadId)"
printf '%s\n' "$state"
