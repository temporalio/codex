// The durable step body: drive one Codex turn through the SDK, with Codex's rollout JSONL as the
// log. Runs inside a Temporal activity, so a worker crash re-runs this one turn; it re-opens the
// thread by id. Node builtins and the Codex SDK are fine here (not workflow code).

import { Context } from "@temporalio/activity";
import { Codex } from "@openai/codex-sdk";
import type { Config } from "./config.js";
import type { RunTurnInput, RunTurnResult } from "./protocol.js";
import { findRollout, inspectPrompt } from "./rollout.js";

// The prompt carries a zero-width marker with its promptId, so a re-driven activity can tell
// whether this exact prompt was already recorded. It also tells our prompts apart from the
// context Codex injects as user messages of its own.
const marker = (promptId: string) => `​[codex-temporal:${promptId}]`;

const heartbeatEvery = (ms: number, details: () => unknown) => {
  const timer = setInterval(() => {
    try {
      Context.current().heartbeat(details());
    } catch {
      // outside an activity context (a unit test); ignore
    }
  }, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

const beat = (details: unknown) => {
  try {
    Context.current().heartbeat(details);
  } catch {
    // outside an activity context; ignore
  }
};

// The last heartbeat of the previous attempt. Codex mints the thread id mid-turn, so this is how
// a retry of a first turn learns the id the workflow never got to hear about.
const threadIdFromLastAttempt = (): string | undefined => {
  try {
    const details = Context.current().info.heartbeatDetails;
    const last = Array.isArray(details) ? details[details.length - 1] : details;
    return typeof last === "string" && last.length > 0 ? last : undefined;
  } catch {
    return undefined;
  }
};

export function makeActivities(cfg: Config) {
  const codex = new Codex({ codexPathOverride: cfg.codexPath });

  const threadOptions = {
    workingDirectory: cfg.projectDir,
    skipGitRepoCheck: true,
    sandboxMode: cfg.sandboxMode,
    ...(cfg.model ? { model: cfg.model } : {}),
  } as const;

  async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    let threadId = input.threadId ?? threadIdFromLastAttempt();
    const stop = heartbeatEvery(3000, () => threadId);

    try {
      if (threadId) {
        const rollout = await findRollout(cfg.sessionsDir, threadId);
        const state = rollout ? await inspectPrompt(rollout, marker(input.promptId)) : undefined;

        if (state?.answered) {
          // A retry that landed after the turn finished but before its result reached Temporal.
          // The answer is already in the log, so there is nothing left to run.
          return { threadId, finalResponse: state.lastAgentMessage, ran: false };
        }
        if (state?.recorded) {
          // The prompt is recorded but the turn never finished. Carry it on rather than asking
          // the same thing twice; Codex fills in a tool call whose output never landed.
          const turn = await codex.resumeThread(threadId, threadOptions).continueTurn();
          return {
            threadId,
            finalResponse: turn.finalResponse || state.lastAgentMessage,
            ran: true,
          };
        }
      }

      const thread = threadId
        ? codex.resumeThread(threadId, threadOptions)
        : codex.startThread(threadOptions);
      const { events } = await thread.runStreamed(`${input.text}${marker(input.promptId)}`);

      let finalResponse = "";
      for await (const event of events) {
        if (event.type === "thread.started") {
          // Heartbeat the id the moment Codex mints it, so a crash from here on resumes this
          // thread instead of starting a second one.
          threadId = event.thread_id;
          beat(threadId);
        } else if (event.type === "item.completed" && event.item.type === "agent_message") {
          finalResponse = event.item.text;
        } else if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        }
      }

      if (!threadId) {
        throw new Error("codex ran a turn without reporting a thread id");
      }
      return { threadId, finalResponse, ran: true };
    } finally {
      stop();
    }
  }

  return { runTurn };
}

export type Activities = ReturnType<typeof makeActivities>;
