"""Exit 0 and print the answer once the thread reports our prompt finished.

Reads a threadState query result on stdin. Keying on the prompt id matters: a session is reused
across turns, so a stale `finished` from the previous turn is the easy thing to mistake for ours.
"""

import json
import sys

state = json.load(sys.stdin)
finished = state.get("finished") or {}
if finished.get("promptId") != sys.argv[1]:
    sys.exit(1)

print(finished.get("outcome", ""))
print(finished.get("finalResponse", ""))
