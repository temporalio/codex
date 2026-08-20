// The durable step body: drive one Codex turn through the SDK, with Codex's rollout JSONL as the
// log. Runs inside a Temporal activity, so a worker crash re-runs this one turn; it re-opens the
// thread by id. Node builtins and the Codex SDK are fine here (not workflow code).

import { Context } from "@temporalio/activity";
import { Codex } from "@openai/codex-sdk";
import type { Config } from "./config.js";
import type { RunTurnInput, RunTurnResult } from "./protocol.js";
import { findRollout, inspectPrompt } from "./rollout.js";
import { reapOrphanedWriter } from "./orphans.js";
import { asActivityFailure } from "./errors.js";

// The prompt carries a zero-width marker with its promptId, so a re-driven activity can tell
// whether this exact prompt was already recorded. It also tells our prompts apart from the
// context Codex injects as user messages of its own.
const marker = (promptId: string) => `​[codex-temporal:${promptId}]`;

const HEARTBEAT_MS = 3000;

/**
 * Heartbeat until the turn goes quiet.
 *
 * A turn that stops producing events is not progress, however healthy the worker is. Codex can
 * hang without dying, and a heartbeat on a timer would report that as healthy forever, pinning
 * the workflow. So the caller kills the child once the gap grows too large, which frees the
 * thread's writer lock and lets Temporal re-drive the turn somewhere else.
 * `progressedAt` is read on every beat, so the caller marks
 * progress by updating it; `onStall` is called once when the gap grows too large.
 */
const heartbeatWhileProgressing = (
  details: () => unknown,
  progressedAt: () => number,
  stallTimeoutMs: number,
  onStall: () => void,
) => {
  let stalled = false;
  const timer = setInterval(() => {
    if (!stalled && Date.now() - progressedAt() > stallTimeoutMs) {
      stalled = true;
      onStall();
      return;
    }
    if (stalled) {
      return;
    }
    try {
      Context.current().heartbeat(details());
    } catch {
      // outside an activity context (a unit test); ignore
    }
  }, HEARTBEAT_MS);
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

// Undefined outside an activity context (a unit test), so callers treat it as optional.
const cancellationSignal = (): AbortSignal | undefined => {
  try {
    return Context.current().cancellationSignal;
  } catch {
    return undefined;
  }
};

const attempt = (): number => {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1;
  }
};

// What a turn reports while it runs. It rides the heartbeat, so `temporal workflow describe`
// shows which step a turn is on without anyone reading the rollout. A turn is the durable unit
// here, so this is how a step is visible at all.
interface TurnProgress {
  readonly threadId?: string;
  // Items codex has finished in this turn: roughly, the steps taken.
  readonly items: number;
  readonly lastItem?: string;
}

// The last heartbeat of the previous attempt. Codex mints the thread id mid-turn, so this is how
// a retry of a first turn learns the id the workflow never got to hear about.
const threadIdFromLastAttempt = (): string | undefined => {
  try {
    const details = Context.current().info.heartbeatDetails;
    const last = Array.isArray(details) ? details[details.length - 1] : details;
    if (typeof last === "string") {
      return last.length > 0 ? last : undefined;
    }
    const threadId = (last as TurnProgress | undefined)?.threadId;
    return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
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
    let progressedAt = Date.now();
    const progress = (): TurnProgress => ({ threadId, items, lastItem });
    let items = 0;
    let lastItem: string | undefined;

    // Kills the codex child: on a stall, and when the workflow interrupts the turn. Without it an
    // interrupt would cancel the activity and leave codex running against the same thread.
    const child = new AbortController();
    let stalledFor = 0;
    const cancellation = cancellationSignal();
    cancellation?.addEventListener("abort", () => child.abort(), { once: true });

    const stop = heartbeatWhileProgressing(
      progress,
      () => progressedAt,
      cfg.stallTimeoutMs,
      () => {
        stalledFor = Date.now() - progressedAt;
        child.abort();
      },
    );
    const turnOptions = { signal: child.signal };

    try {
      if (threadId && attempt() > 1) {
        // A worker killed outright cannot clean up after itself, so its codex may still be
        // holding this thread and would block the resume below.
        const { killed, liveHolders } = await reapOrphanedWriter(cfg.codexHome, threadId);
        if (killed.length > 0) {
          console.log(`reaped orphaned codex ${killed.join(", ")} holding thread ${threadId}`);
        }
        if (liveHolders.length > 0) {
          throw new Error(
            `thread ${threadId} is held by a live codex (${liveHolders.join(", ")}); ` +
              `an earlier attempt is still running somewhere`,
          );
        }
      }

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
          const turn = await codex.resumeThread(threadId, threadOptions).continueTurn(turnOptions);
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
      const { events } = await thread.runStreamed(
        `${input.text}${marker(input.promptId)}`,
        turnOptions,
      );

      let finalResponse = "";
      for await (const event of events) {
        progressedAt = Date.now();
        if (event.type === "thread.started") {
          // Heartbeat the id the moment Codex mints it, so a crash from here on resumes this
          // thread instead of starting a second one.
          threadId = event.thread_id;
          beat(progress());
        } else if (event.type === "item.completed") {
          items++;
          lastItem = event.item.type;
          if (event.item.type === "agent_message") {
            finalResponse = event.item.text;
          }
        } else if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        }
      }

      if (!threadId) {
        throw new Error("codex ran a turn without reporting a thread id");
      }
      return { threadId, finalResponse, ran: true };
    } catch (err) {
      if (stalledFor > 0) {
        throw new Error(
          `codex produced no events for ${Math.round(stalledFor / 1000)}s and was killed; ` +
            `the turn will be carried on by the next attempt`,
          { cause: err },
        );
      }
      throw asActivityFailure(err);
    } finally {
      stop();
    }
  }

  return { runTurn };
}

export type Activities = ReturnType<typeof makeActivities>;
