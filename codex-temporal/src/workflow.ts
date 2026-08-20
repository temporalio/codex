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

const { runTurn } = proxyActivities<{
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
}>({
  // A turn is a whole Codex run (many model calls and tools), so give it room; the heartbeat is
  // the real liveness bound and re-drives within seconds of a worker death.
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 100 },
});

export const submitPrompt = defineSignal<[PromptInput]>(SIGNALS.submitPrompt);
export const interrupt = defineSignal<[]>(SIGNALS.interrupt);
export const threadState = defineQuery<ThreadState>(QUERIES.threadState);

export async function codexThread(sessionId: string, options?: ThreadOptions): Promise<void> {
  const idleTimeout = options?.idleTimeout ?? "5 minutes";
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
    let outcome: NonNullable<ThreadState["finished"]>["outcome"] = "interrupted";
    let finalResponse = "";
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
      // An interrupt cancels the in-flight turn; the thread keeps serving later prompts. A real
      // run error is already recorded in the rollout, so we log-and-continue rather than fail the
      // whole thread. (Surfacing typed errors to the caller is a follow-up.)
      if (!isCancellation(err)) {
        // TODO: classify and, for genuine failures, decide retry vs surface. For now, continue.
      }
    } finally {
      current = undefined;
      running = undefined;
      finished = { promptId: prompt.promptId, outcome, finalResponse };
    }
  }
}
