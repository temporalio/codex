// Names and shapes shared by the workflow, the client, and (type-only) the activities.
// Keep this free of the Codex SDK and Node builtins: the workflow bundles it into the sandbox.

export const WORKFLOW_TYPE = "codexThread";
export const WORKFLOW_ID_PREFIX = "codex-thread-";

export const workflowId = (sessionId: string) => `${WORKFLOW_ID_PREFIX}${sessionId}`;

export const SIGNALS = {
  submitPrompt: "submitPrompt",
  interrupt: "interrupt",
} as const;

export const QUERIES = {
  threadState: "threadState",
} as const;

export interface PromptInput {
  // Deterministic id for this prompt, so a re-driven activity can tell whether it already ran.
  readonly promptId: string;
  readonly text: string;
}

export interface RunTurnInput extends PromptInput {
  readonly sessionId: string;
  // Codex mints the thread id on the first turn, so it is absent then and known after. The
  // workflow is what remembers it, which is why it rides in the input.
  readonly threadId?: string;
}

export interface RunTurnResult {
  // Codex's id for the thread this turn ran in. The workflow keeps it for later turns.
  readonly threadId: string;
  readonly finalResponse: string;
  // Whether this call drove a turn, or found the prompt already answered and returned the answer.
  readonly ran: boolean;
}

// What the thread is doing, for anyone watching from outside. The conversation itself is in
// Codex's rollout file, not here.
export interface ThreadState {
  readonly queued: number;
  readonly threadId?: string;
  readonly running?: { readonly promptId: string };
  readonly finished?: {
    readonly promptId: string;
    readonly outcome: "answered" | "interrupted";
    readonly finalResponse: string;
  };
}

export interface ThreadOptions {
  // How long the workflow stays alive with no work before it retires. The next prompt starts a
  // fresh run, which rebuilds nothing: Codex's rollout already holds the conversation.
  readonly idleTimeout?: string;
}
