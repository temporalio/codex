// Reading Codex's rollout log. That file is the durable record of a thread, so it is also the
// only honest way to ask "was this prompt already recorded?" after a crash.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

interface Line {
  readonly type?: string;
  readonly payload?: {
    readonly type?: string;
    readonly role?: string;
    readonly content?: unknown;
    readonly call_id?: string;
  };
}

// Codex reaches its tools by several item shapes: the classic function call, the shell call, and
// the custom tool call that code mode uses.
const TOOL_CALLS = new Set(["function_call", "local_shell_call", "custom_tool_call", "tool_search_call"]);
const TOOL_OUTPUTS = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
]);

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { text?: string } | null)?.text ?? "").join("");
};

/** Codex writes rollouts under sessions/YYYY/MM/DD, so the thread id has to be searched for. */
export async function findRollout(sessionsDir: string, threadId: string): Promise<string | undefined> {
  const suffix = `-${threadId}.jsonl`;
  const walk = async (dir: string): Promise<string | undefined> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (entry.endsWith(suffix)) return path;
      const info = await stat(path).catch(() => undefined);
      if (info?.isDirectory()) {
        const found = await walk(path);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(sessionsDir);
}

async function lines(path: string): Promise<Line[]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Line];
      } catch {
        // A crash can leave the last line half-written. Everything before it still counts.
        return [];
      }
    });
}

export interface RolloutSummary {
  readonly userMessages: number;
  readonly agentMessages: number;
  readonly toolCalls: number;
  readonly toolOutputs: number;
  readonly lastAgentMessage: string;
}

export async function summarize(path: string): Promise<RolloutSummary> {
  let userMessages = 0;
  let agentMessages = 0;
  let toolCalls = 0;
  let toolOutputs = 0;
  let lastAgentMessage = "";

  for (const line of await lines(path)) {
    if (line.type !== "response_item") continue;
    const payload = line.payload;
    if (!payload) continue;
    if (payload.type === "message" && payload.role === "user") userMessages++;
    if (payload.type === "message" && payload.role === "assistant") {
      agentMessages++;
      const text = textOf(payload.content).trim();
      if (text) lastAgentMessage = text;
    }
    if (TOOL_CALLS.has(payload.type ?? "")) toolCalls++;
    if (TOOL_OUTPUTS.has(payload.type ?? "")) toolOutputs++;
  }

  return { userMessages, agentMessages, toolCalls, toolOutputs, lastAgentMessage };
}

// Codex renamed these; a rollout written by an older build uses the task_* spelling.
const TURN_DONE = new Set(["turn_complete", "task_complete"]);

export interface PromptState {
  /** Whether a user message carrying this marker is in the rollout at all. */
  readonly recorded: boolean;
  /** Whether a turn finished after it, so the answer is already in the log. */
  readonly answered: boolean;
  readonly lastAgentMessage: string;
}

/** What the rollout says about one prompt: never recorded, recorded and answered, or cut short. */
export async function inspectPrompt(path: string, marker: string): Promise<PromptState> {
  let recorded = false;
  let answered = false;
  let lastAgentMessage = "";

  for (const line of await lines(path)) {
    const payload = line.payload;
    if (!payload) continue;

    if (
      !recorded &&
      line.type === "response_item" &&
      payload.type === "message" &&
      payload.role === "user" &&
      textOf(payload.content).includes(marker)
    ) {
      recorded = true;
      continue;
    }
    if (!recorded) continue;

    if (line.type === "event_msg" && payload.type && TURN_DONE.has(payload.type)) {
      answered = true;
    }
    if (line.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
      const text = textOf(payload.content).trim();
      if (text) lastAgentMessage = text;
    }
  }

  return { recorded, answered, lastAgentMessage };
}

/** Whether the rollout ends with a tool call whose output never landed: a crash mid-turn. */
export async function hasUnsettledToolCall(path: string): Promise<boolean> {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const line of await lines(path)) {
    if (line.type !== "response_item") continue;
    const payload = line.payload;
    const id = payload?.call_id;
    if (!id) continue;
    if (TOOL_CALLS.has(payload?.type ?? "")) calls.add(id);
    if (TOOL_OUTPUTS.has(payload?.type ?? "")) outputs.add(id);
  }
  for (const id of calls) if (!outputs.has(id)) return true;
  return false;
}
