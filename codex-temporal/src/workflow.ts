// The per-thread durable executor. One workflow per Codex thread. It owns the small control state
// (the pending-prompt queue, and the thread id Codex minted); the conversation lives in Codex's
// rollout JSONL, which the runTurn activity reads and writes. A crash re-drives the turn in
// flight on another worker.
//
// Sandbox-safe: only @temporalio/workflow and type-only protocol imports. No Codex SDK, no Node.

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  CancellationScope,
  isCancellation,
} from "@temporalio/workflow";
import { QUERIES, SIGNALS } from "./protocol.js";
import type {
  PromptInput,
  RunTurnInput,
  RunTurnResult,
  ThreadOptions,
  ThreadState,
} from "./protocol.js";

export const submitPrompt = defineSignal<[PromptInput]>(SIGNALS.submitPrompt);
export const interrupt = defineSignal<[]>(SIGNALS.interrupt);
export const threadState = defineQuery<ThreadState>(QUERIES.threadState);

export async function codexThread(sessionId: string, options?: ThreadOptions): Promise<void> {
  const idleTimeout = options?.idleTimeout ?? "5 minutes";
  const { runTurn } = proxyActivities<{
    runTurn(input: RunTurnInput): Promise<RunTurnResult>;
  }>({
    // A turn is a whole Codex run (many model calls and tools), so give it room; the heartbeat is
    // the real liveness bound and re-drives within seconds of a worker death.
    startToCloseTimeout: options?.turnTimeout ?? "1 hour",
    heartbeatTimeout: "30 seconds",
    // Few, not many. Every attempt of a turn that cannot succeed costs a model call, and the
    // activity marks the failures that no retry can help as non-retryable anyway.
    retry: { maximumAttempts: options?.maxAttempts ?? 5 },
  });
  const queue: PromptInput[] = [];
  let current: CancellationScope | undefined;
  // Codex mints this on the first turn. Keeping it here is what makes later turns resume the same
  // thread: the workflow is the durable memory, not the worker.
  let threadId: string | undefined;
  let running: ThreadState["running"];
  let finished: ThreadState["finished"];

  setHandler(submitPrompt, (p) => {
    queue.push(p);
  });
  setHandler(interrupt, () => {
    current?.cancel();
  });
  setHandler(threadState, () => ({ queued: queue.length, threadId, running, finished }));

  for (;;) {
    const woke = await condition(() => queue.length > 0, idleTimeout);
    if (!woke && queue.length === 0) return; // idle: retire; the next prompt starts a fresh run

    const prompt = queue.shift()!;
    let outcome: NonNullable<ThreadState["finished"]>["outcome"] = "failed";
    let finalResponse = "";
    let error: string | undefined;
    try {
      await CancellationScope.cancellable(async () => {
        current = CancellationScope.current();
        running = { promptId: prompt.promptId };
        const input: RunTurnInput = { sessionId, threadId, ...prompt };
        const result = await runTurn(input);
        threadId = result.threadId;
        finalResponse = result.finalResponse;
        outcome = "answered";
      });
    } catch (err) {
      // An interrupt cancels the in-flight turn; the thread keeps serving later prompts. A turn
      // that ran out of attempts is a different thing, and it says why: the thread stays up so a
      // later prompt can still work, but nobody has to read the worker log to find out what broke.
      if (isCancellation(err)) {
        outcome = "interrupted";
      } else {
        error = failureText(err);
      }
    } finally {
      current = undefined;
      running = undefined;
      finished = { promptId: prompt.promptId, outcome, finalResponse, error };
    }
  }
}

// Temporal wraps an activity failure, so the message worth reporting is on the cause. Walking the
// chain keeps this readable in a query rather than "Activity task failed".
function failureText(err: unknown): string {
  let current: unknown = err;
  let text = "";
  for (let depth = 0; current && depth < 8; depth++) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) text = message;
    current = (current as { cause?: unknown }).cause;
  }
  return text || String(err);
}
