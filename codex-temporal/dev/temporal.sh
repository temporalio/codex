#!/usr/bin/env bash
# A local Temporal server for this stack only. Run it in its own shell and leave it.
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

if port_taken "$TEMPORAL_PORT"; then
  die "port $TEMPORAL_PORT is taken. If that is your own Temporal, use it as is, or move this one:
  TEMPORAL_PORT=7245 TEMPORAL_UI_PORT=8245 dev/temporal.sh"
fi

# A file db, so workflows survive restarting the server. That matters here: the whole point is
# showing that work outlives a process.
say "Temporal on $TEMPORAL_ADDRESS, UI on http://127.0.0.1:$TEMPORAL_UI_PORT, db $STATE_DIR/temporal.db"

# Record before exec, so the pid stays right after this shell is replaced.
record_pid temporal $$
exec temporal server start-dev \
  --port "$TEMPORAL_PORT" \
  --ui-port "$TEMPORAL_UI_PORT" \
  --db-filename "$STATE_DIR/temporal.db" \
  --log-level warn
