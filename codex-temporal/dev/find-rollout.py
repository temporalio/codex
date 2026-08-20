"""Find the rollout a prompt landed in, by scanning for a token in the prompt text.

The workflow only learns the thread id from the activity's result, so asking it mid-turn tells you
nothing. Codex writes the rollout as the turn happens, and names the file after the thread, so the
sessions directory answers the question while the turn is still running, and after the worker dies.
"""

import json
import pathlib
import re
import sys

sessions, token = pathlib.Path(sys.argv[1]), sys.argv[2]

candidates = sorted(sessions.rglob("rollout-*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
for path in candidates[:200]:
    try:
        if token not in path.read_text(encoding="utf-8", errors="ignore"):
            continue
    except OSError:
        continue
    # rollout-<timestamp>-<threadId>.jsonl, and the timestamp is dashed too, so anchor on the uuid.
    match = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", path.stem)
    print(json.dumps({"path": str(path), "threadId": match.group(1) if match else ""}))
    sys.exit(0)

sys.exit(1)
