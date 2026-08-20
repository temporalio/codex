"""Print the attempt the activity was on when it last started.

Temporal does not add a history event per retry: the ActivityTaskStarted event carries the attempt
of the attempt that finished. So a 2 here is the proof that a turn was re-driven, and it is the one
claim a crash test cannot fake by finishing early.
"""

import json
import sys

history = json.load(sys.stdin)
events = history.get("events") or history.get("history", {}).get("events", [])

attempt = 0
for event in events:
    started = event.get("activityTaskStartedEventAttributes")
    if started:
        attempt = started.get("attempt", 1)
print(attempt)
