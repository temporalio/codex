// Deciding which failures are worth another attempt.
//
// A retry helps when the cause was the process dying or the turn stalling: the rollout is intact
// and another worker carries the turn on. It helps with nothing when the codex binary is missing or
// unusable, because every attempt fails the same way and the real reason ends up buried under a
// pile of identical errors.

import { ApplicationFailure } from "@temporalio/activity";

export const SPAWN_FAILURE = "CodexNotRunnable";

const SPAWN_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);
const SPAWN_TEXT = /\bENOENT\b|\bEACCES\b|\bEPERM\b|\bENOTDIR\b|\bspawn\b .*\bfailed\b/i;

const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** Walk the cause chain, because a spawn error usually arrives wrapped by the SDK. */
const chain = (err: unknown): unknown[] => {
  const seen: unknown[] = [];
  let current = err;
  while (current && seen.length < 8 && !seen.includes(current)) {
    seen.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return seen;
};

export const messageOf = (err: unknown): string => {
  const deepest = chain(err).at(-1);
  if (deepest instanceof Error && deepest.message) return deepest.message;
  if (err instanceof Error) return err.message;
  return String(err);
};

/** Whether this failure would fail the same way on every later attempt. */
export function isSpawnFailure(err: unknown): boolean {
  return chain(err).some((link) => {
    const code = codeOf(link);
    if (code && SPAWN_CODES.has(code)) return true;
    return link instanceof Error && SPAWN_TEXT.test(link.message);
  });
}

/**
 * The error to throw out of the activity: unchanged when a retry could help, and non-retryable
 * when nothing about waiting or moving worker would change the outcome.
 */
export function asActivityFailure(err: unknown): unknown {
  if (!isSpawnFailure(err)) return err;
  return ApplicationFailure.create({
    message: `codex could not be run: ${messageOf(err)}`,
    type: SPAWN_FAILURE,
    nonRetryable: true,
    cause: err instanceof Error ? err : undefined,
  });
}
