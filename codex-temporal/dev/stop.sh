#!/usr/bin/env bash
# Stop what these scripts started, and nothing else. Only recorded pids are touched, so another
# session's Temporal or worker on this machine is left alone.
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

for name in worker temporal; do
  pid=$(read_pid "$name")
  if alive "$pid"; then
    say "stopping $name ($pid)"
    stop_tree "$name"
  else
    rm -f "$PID_DIR/$name.pid"
  fi
done

for port in "$TEMPORAL_PORT" "$TEMPORAL_UI_PORT"; do
  if port_taken "$port"; then say "note: port $port is still in use, by something we did not start."; fi
done
say "done."
