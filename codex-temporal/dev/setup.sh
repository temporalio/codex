#!/usr/bin/env bash
# Install deps and check the things whose absence gives a confusing failure later.
set -euo pipefail
# shellcheck source=./common.sh
source "$(cd -- "$(dirname -- "$0")" && pwd)/common.sh"

(cd "$PKG_DIR" && npm install --silent)

command -v temporal >/dev/null || die "no temporal CLI on PATH. See https://docs.temporal.io/cli"
command -v python3 >/dev/null || die "no python3 on PATH; the dev scripts read rollouts with it"

[ -x "$CODEX_PATH" ] || die "no codex build at $CODEX_PATH
Build it:  cd $REPO_DIR/codex-rs && CARGO_NET_GIT_FETCH_WITH_CLI=true cargo build -p codex-cli --bin codex"

"$CODEX_PATH" exec resume --help 2>/dev/null | grep -q -- --continue \
  || die "$CODEX_PATH has no 'exec resume --continue'. That build is not from this fork."

# Codex routes shell tools through a host that embeds V8, and the rusty_v8 prebuilt for this target
# is a 404, so a source build cannot produce it. The prebuilt from npm works with a fork binary.
host="$(dirname "$CODEX_PATH")/codex-code-mode-host"
if [ ! -x "$host" ]; then
  say "warning: no codex-code-mode-host next to the binary, so tool calls will not run."
  say "         Copy it out of the @openai/codex npm platform package to $host,"
  say "         or skip dev/crash-tool.sh, which needs tools."
fi

[ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ] || say "warning: no Codex auth found; run '$CODEX_PATH login' first."

say "ok. state dir $STATE_DIR, task queue $CODEX_TEMPORAL_TASK_QUEUE, Temporal $TEMPORAL_ADDRESS"
