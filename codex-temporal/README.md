# codex-temporal

A Temporal-backed durable executor for the [Codex CLI](https://github.com/openai/codex). Same pattern we proved on the OpenCode fork and on Pi: the agent's own loop runs under a durable executor, while the session record stays in the app's own log.

Status: verified end to end against a live Codex built from this fork. Two turns on one thread work, and a worker killed mid-turn finishes that turn on a fresh worker without asking the same thing twice.

## The idea

Two parts of the state, two systems:

- **Durable storage** stays with Codex. Codex already writes every turn to a rollout JSONL under `~/.codex/sessions`, and `codex exec resume <id>` reads it back. That file is the source of truth. We do not move it into Temporal.
- **Durable execution** comes from Temporal. A per-thread workflow drives Codex's turns and survives a crash: the turn re-runs on another worker and picks up from the rollout.

One turn is one activity, and one turn is one `codex exec` process. That process boundary is what makes this the cleanest of the three integrations: there is no long-lived agent object to rebuild, so a crash is just a process that has to be run again.

## What Codex already had

Two things we had to add to Pi are already in Codex, which is worth saying plainly:

- **A crash-truncated rollout is repaired on the way to the model.** `ensure_call_outputs_present` (`codex-rs/core/src/context_manager/normalize.rs`) synthesizes a `FunctionCallOutput` for any tool call whose output never landed, so the payload a resumed thread sends is valid. The synthetic outputs are not written back to the rollout.
- **A turn can run with no new user message.** `turn/start` with empty input is a supported, tested path in the app-server protocol.

## What this fork adds

The second one was not reachable from the shipping CLI: `codex exec resume <id>` always resolves a prompt, so a retry after a mid-turn crash could only ask the same thing twice. This fork exposes it.

- `codex exec resume <id> --continue` runs a turn with no new user message. Use it to finish a turn that stopped part way through.
- `Thread.continueTurn()` and `Thread.continueTurnStreamed()` in the TypeScript SDK do the same from code.

Both are small: the CLI flag maps to the empty-input turn that already existed, and the SDK method reuses the turn collector that `run()` already had.

## What is durable, and what is not

- **Between turns: clean.** A worker dying between turns loses nothing. The next prompt drives on any worker, and Codex reads the rollout back. The workflow is what remembers the thread id, so the next turn resumes the same thread rather than starting a new one.
- **Mid-turn: the turn is carried on, not restarted.** On a retry, the activity looks for its own prompt in the rollout. Recorded and answered means the answer is already there and nothing needs to run. Recorded and unfinished means `continueTurn()`, so the prompt is not asked twice.
- **A first turn that dies before Codex minted a thread id** starts over, which is correct: nothing had been recorded yet. Once the id exists the activity heartbeats it, so a retry from that point resumes rather than opening a second thread.
- **Tool side effects are not rolled back.** A crash between a tool starting and its result landing leaves a tool call with no output, and Codex reports it to the model as `"aborted"`. For a coding agent that is optimistic: after a hard kill the command may well have run. Reporting the outcome as unknown, which is what we did on the Pi fork, is the safer default and is the natural next change here.

## Running it

```
npm install
CODEX_PATH=../codex-rs/target/debug/codex npm run worker      # in one shell
npx tsx submit.mts my-session "Reply with the single word BRAVO."
npx tsx state.mts my-session
npx tsx inspect.mts <threadId>
```

The worker needs a Codex build from this fork, because it calls `--continue`. Build it with `cargo build -p codex-cli --bin codex` in `codex-rs` (set `CARGO_NET_GIT_FETCH_WITH_CLI=true` if a git dependency fails to authenticate).

Env: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `CODEX_TEMPORAL_TASK_QUEUE`, `CODEX_SESSIONS_DIR`, `CODEX_IDLE_TIMEOUT`, `CODEX_PATH`, `CODEX_MODEL`, `CODEX_PROJECT_DIR`, `CODEX_SANDBOX`.

`temporal workflow query --workflow-id codex-thread-<session> --name threadState` reports the queue, the thread id, the turn in flight, and how the last turn ended.

## Reproducing the crash test

Submit a turn long enough to still be running a few seconds in, wait until the prompt is in the rollout with no turn completion after it, `pkill -9 -f "codex-temporal.*src/worker.ts"`, wait past the 30s heartbeat timeout, then start a fresh worker. The activity comes back on attempt 2, the turn finishes, and the rollout holds exactly one copy of the prompt.

The observed run: before the kill, 1 prompt and 0 turn completions; after recovery, 1 prompt and 1 turn completion, with the answer running to the end.

## Layout

- `src/config.ts` — Temporal + Codex wiring from env.
- `src/protocol.ts` — workflow id, signal and query names, shared types.
- `src/rollout.ts` — reading Codex's rollout: find it by thread id, and ask what it says about one prompt.
- `src/activities.ts` — `runTurn`: drives one Codex turn through the SDK.
- `src/workflow.ts` — `codexThread`: per-thread durable executor (submit prompt, drive, interrupt, idle-retire).
- `src/worker.ts` — worker hosting the workflow and the activity.
- `src/client.ts` — submit a prompt, read thread state, interrupt.

## Known gaps

- **No step level.** A turn is the smallest durable unit here. Codex has no "run one model call and its tools, then stop" surface, so a crash re-drives from wherever the rollout left off rather than from the last step. On the Pi fork we added stepping; the same change here is a core change, not a CLI change.
- **A settled tool call is reported as aborted, not unknown.** See above.
- **Tool execution needs a release build.** Codex routes shell tools through a code-mode host that embeds V8, and there is no prebuilt V8 archive for `aarch64-apple-darwin` in this version, so a source build cannot run tool calls. The crash test above therefore uses a long generation rather than a tool call.
