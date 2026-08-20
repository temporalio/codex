"""Count the user messages in a rollout that carry a token, and report the tool-call balance.

Counting *all* user messages would lie: Codex injects its own context as user-role messages, and it
does so again on a resume. A token we put in the prompt text is the only thing that tells our own
prompt apart, which is what makes "was it asked twice?" answerable.
"""

import json
import sys

path, token = sys.argv[1], sys.argv[2]

TOOL_CALLS = {"function_call", "custom_tool_call", "local_shell_call"}
TOOL_OUTPUTS = {"function_call_output", "custom_tool_call_output"}

prompts = calls = outputs = 0
last_agent = ""

with open(path, encoding="utf-8") as fh:
    for line in fh:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "response_item":
            continue
        payload = entry.get("payload") or {}
        kind = payload.get("type")
        if kind == "message" and payload.get("role") == "user":
            if token in json.dumps(payload.get("content")):
                prompts += 1
        elif kind == "message" and payload.get("role") == "assistant":
            text = json.dumps(payload.get("content"))
            if text:
                last_agent = text
        if kind in TOOL_CALLS:
            calls += 1
        if kind in TOOL_OUTPUTS:
            outputs += 1

print(json.dumps({"prompts": prompts, "toolCalls": calls, "toolOutputs": outputs, "lastAgent": last_agent[-200:]}))
