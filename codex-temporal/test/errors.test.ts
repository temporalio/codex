// The classifier decides whether a turn gets another attempt, so the cases that matter are the two
// ways it can be wrong: retrying something that will never work, and giving up on something a
// second worker would have finished.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationFailure } from "@temporalio/activity";
import { asActivityFailure, isSpawnFailure, messageOf, SPAWN_FAILURE } from "../src/errors.js";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

test("a missing codex binary is not worth retrying", () => {
  assert.equal(isSpawnFailure(withCode("spawn /nope/codex ENOENT", "ENOENT")), true);
  assert.equal(isSpawnFailure(withCode("permission problem", "EACCES")), true);
});

test("a spawn failure wrapped by the SDK is still recognised", () => {
  const wrapped = new Error("failed to start codex", { cause: withCode("boom", "ENOENT") });
  assert.equal(isSpawnFailure(wrapped), true);
});

test("an ordinary turn failure stays retryable", () => {
  // The model reporting a failed tool, or a rate limit, is exactly what a retry is for.
  assert.equal(isSpawnFailure(new Error("turn failed: file not found in workspace")), false);
  assert.equal(isSpawnFailure(new Error("429 rate limit exceeded")), false);
  assert.equal(isSpawnFailure(new Error("codex produced no events for 18s and was killed")), false);
});

test("a retryable error is passed through untouched", () => {
  const err = new Error("429 rate limit exceeded");
  assert.equal(asActivityFailure(err), err);
});

test("a spawn failure becomes a non-retryable failure that names the cause", () => {
  const failure = asActivityFailure(withCode("spawn /nope/codex ENOENT", "ENOENT"));
  assert.ok(failure instanceof ApplicationFailure);
  assert.equal(failure.nonRetryable, true);
  assert.equal(failure.type, SPAWN_FAILURE);
  assert.match(failure.message, /ENOENT/);
});

test("the reported message comes from the deepest cause", () => {
  const wrapped = new Error("outer", { cause: new Error("inner", { cause: new Error("root") }) });
  assert.equal(messageOf(wrapped), "root");
});

test("a cause cycle does not hang the walk", () => {
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  (a as { cause?: unknown }).cause = b;
  assert.equal(isSpawnFailure(a), false);
  assert.ok(messageOf(a).length > 0);
});
