#!/usr/bin/env bash
# The durable executor. Run as many as you like; they all pull the same task queue.
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

require_temporal
[ -x "$CODEX_PATH" ] || die "no codex build at $CODEX_PATH. Run dev/setup.sh."

record_pid worker $$
cd "$PKG_DIR"
exec ./node_modules/.bin/tsx src/worker.ts
