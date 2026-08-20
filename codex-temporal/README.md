# codex-temporal

A Temporal-backed durable executor for the [Codex CLI](https://github.com/openai/codex). Same pattern we proved on the OpenCode fork and on Pi: the agent's own loop runs under a durable executor, while the session record stays in the app's own log.

Status: verified end to end against a live Codex built from this fork. Two turns on one thread work, and a worker killed mid-tool-call finishes that turn on a fresh worker: no duplicate prompt, and the tool that had already completed does not run again.

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

**Reaching the empty-input turn.** It was not available from the shipping CLI: `codex exec resume <id>` always resolves a prompt, so a retry after a mid-turn crash could only ask the same thing twice.

- `codex exec resume <id> --continue` runs a turn with no new user message. Use it to finish a turn that stopped part way through.
- `Thread.continueTurn()` and `Thread.continueTurnStreamed()` in the TypeScript SDK do the same from code.

Both are small: the CLI flag maps to the empty-input turn that already existed, and the SDK method reuses the turn collector that `run()` already had.

**Making a crash-truncated thread resumable at all.** `ensure_call_outputs_present` filled a missing tool output quietly for a function call, but called `error_or_panic` for a custom tool call or a local shell call. Code mode dispatches custom tool calls, so that is the ordinary case: kill Codex during a tool and the thread could not be resumed. A debug build panicked the runtime worker, and the process then sat holding the thread's writer lock, which made every later resume fail with `already has an active writer`. A release build logged an error instead and carried on.

A gap there is expected, not a defect, so all three now log it the same way. The recovery code was already sitting directly after the panic, which is the tell.

**Ending a turn whose task died.** A panic inside the turn task unwound past both the finish hook and the waiters, so a client waited for a terminal event that never came and codex stayed alive holding the writer lock. The task now runs under `catch_unwind`, and a panic becomes a fatal task error that flows through the same finish hook as any other failure. That is the general guard behind the specific fix above.

**Not leaving a child behind.** The SDK aborted a turn by sending the child a polite signal and trusting it to exit. A child that ignores it keeps running, and codex holds a writer lock on the thread for as long as it lives, so every later resume of that thread fails with `already has an active writer`. An aborted turn now escalates to `SIGKILL` after a grace period.

**Saying what actually happened.** The synthesized output used to read `aborted`. After a hard kill that is optimistic: the command may well have run. It now says the outcome is unknown and the state should be checked before repeating the call. This does not touch the interrupt path, which writes its own richer output (`Wall time: N seconds` plus `aborted by user`); the placeholder is only reached when nothing was recorded at all.

## A hang is worse than a crash

Temporal handles a crash: the heartbeat stops, the activity times out, another worker picks the turn up. A hang is the dangerous shape, because a heartbeat on a timer reports a wedged process as healthy forever and the workflow waits behind it.

So the activity heartbeats on progress, not on the clock. Every event from codex marks progress; if the gap grows past `CODEX_STALL_TIMEOUT_MS` (10 minutes by default, long enough for a slow tool), the child is killed and the activity fails with what happened. Temporal then re-drives the turn, and because the child is gone the thread's lock is free for the next attempt to take.

The same abort is wired to activity cancellation, so interrupting a turn stops codex rather than leaving it running against the thread.

A worker killed outright cannot run any of that, so its codex can outlive it. A codex that is mid-stream dies on its own, because writing to the closed pipe kills it; a quiet one, which is the hung case again, keeps running and keeps the thread's writer lock. Every later attempt would then fail with `already has an active writer` until it finishes. So a retry reaps first: it looks for a process holding that thread's lock file and kills it, but only if the process has been reparented, which happens exactly when the worker that spawned it is gone. A codex being driven by another live worker fails that test and is left alone; the attempt fails saying so, rather than fighting over the thread.

Observed against a stand-in that reports a thread and then ignores both events and `SIGTERM`: the activity failed with `codex produced no events for 18s and was killed; the turn will be carried on by the next attempt`, and moved to attempt 2.

Reaping observed against a real thread held by a detached process: a resume failed with `already has an active writer`, the reaper reported `{"killed":[14195],"liveHolders":[]}`, and the same resume then ran to completion. A holder with a live parent came back as `{"killed":[],"liveHolders":[15127]}` and was left running.

## What is durable, and what is not

- **Between turns: clean.** A worker dying between turns loses nothing. The next prompt drives on any worker, and Codex reads the rollout back. The workflow is what remembers the thread id, so the next turn resumes the same thread rather than starting a new one.
- **Mid-turn: the turn is carried on, not restarted.** On a retry, the activity looks for its own prompt in the rollout. Recorded and answered means the answer is already there and nothing needs to run. Recorded and unfinished means `continueTurn()`, so the prompt is not asked twice.
- **A first turn that dies before Codex minted a thread id** starts over, which is correct: nothing had been recorded yet. Once the id exists the activity heartbeats it, so a retry from that point resumes rather than opening a second thread.
- **Tool side effects are not rolled back, and are not repeated either.** A crash between a tool starting and its result landing leaves a tool call with no output. The model is told the outcome is unknown and decides what to do, which is the safe default for a coding agent. Tools that had already completed keep their recorded results and do not run again.
- **The rollout stays honest about the gap.** Codex does not write the synthesized output back, so a thread that survived a crash keeps one more tool call than tool outputs on disk forever. That is the record telling the truth, not a defect.

## Running it

`dev/` brings the whole stack up. It runs off the default ports and tracks every process by pid, so
it cannot disturb, or be disturbed by, a Temporal or a Codex already running on the machine.

```
dev/setup.sh                                        # once: deps, and a preflight that explains itself

dev/temporal.sh                                     # shell 1: Temporal on 127.0.0.1:7244, UI on 8244
dev/worker.sh                                       # shell 2: the durable executor

dev/ask.sh "Reply with the single word BRAVO."       # submit and wait for the answer
dev/ask.sh smoke "What word did you just say?"       # same session twice: turn 2 resumes the thread
dev/state.sh smoke                                  # what the thread is doing
dev/inspect.sh smoke                                # what the rollout says, worker or no worker
dev/stop.sh                                         # stops only what dev/ started
```

`TEMPORAL_PORT=7245 TEMPORAL_UI_PORT=8245` moves it if those ports are taken.

By hand, if you would rather:

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

`temporal workflow describe` shows how far the running turn has got, because the heartbeat carries it: `[{"items":6,"lastItem":"command_execution","threadId":"..."}]`. Heartbeats are throttled against the heartbeat timeout, so it moves in jumps rather than on every item.

## Reproducing the crash test

```
dev/crash-worker.sh    # killed during a long generation
dev/crash-tool.sh      # killed with one tool settled and one in flight
```

Both print PASS or FAIL and exit non-zero on failure, and both kill the worker by recorded pid, so nothing else on the machine is at risk.

Each one refuses to conclude anything from a turn that already finished, and that guard earns its place. The first version of these scripts waited for the workflow to report a thread id, which only arrives with the activity's *result*, so the kill always landed after the turn was over and every assertion passed for the wrong reason. They now find the rollout by a token in the prompt text, which Codex writes while the turn runs, and they check the activity attempt afterwards. An attempt of 2 is the one claim an early-finishing turn cannot fake.

`dev/crash-tool.sh` is the one worth watching. It asks for two shell commands, the second slow, and waits until the rollout holds more tool calls than tool outputs before killing the worker.

```
before the kill: 1 prompt, 2 tool calls, 1 tool output,  a.txt 1 line
after recovery:  1 prompt, 6 tool calls, 6 tool outputs, a.txt 1 line, answer DELTA, attempt 2
```

`a.txt` still holding one line is the assertion that matters: the settled tool kept its recorded result and did not run again. The tool count rising to 6 is the unknown-outcome wording working as intended. The model was told the interrupted call's outcome was unknown, so it went and checked the state rather than repeating the command.

## Layout

- `src/config.ts` — Temporal + Codex wiring from env.
- `src/protocol.ts` — workflow id, signal and query names, shared types.
- `src/rollout.ts` — reading Codex's rollout: find it by thread id, and ask what it says about one prompt.
- `src/activities.ts` — `runTurn`: drives one Codex turn through the SDK.
- `src/workflow.ts` — `codexThread`: per-thread durable executor (submit prompt, drive, interrupt, idle-retire).
- `src/worker.ts` — worker hosting the workflow and the activity.
- `src/client.ts` — submit a prompt, read thread state, interrupt.

## Known gaps

- **No step level, and it costs less than it sounds.** A turn is the smallest durable unit here, but that is not the same gap it was on the Pi fork. Codex records each item to the rollout as it happens, and a resumed turn picks up from there, so the work lost to a crash is already about one step: the tool-crash test above finished the turn with the completed tool's side effect intact and not repeated. What a step-per-activity design would add is control and visibility, not saved work, and the visibility half is covered by the progress on the heartbeat.

  The remaining half is not cheap. `run_turn` does have a step loop, so stopping after one step is a small change on its own, but a turn that stops early is not a completed turn, and this protocol has no way to say that: the app-server would emit `turn/completed` for something still mid-conversation. Making it honest means a new terminal turn status threaded through the app-server, both SDKs, the rollout projection that reconstructs turns (`build_turns_from_rollout_items`, which fork and rollback depend on), and the TUI. That is a large, invasive change for control this executor does not currently need, so it is deliberately not built.
- **A source build cannot compile the code-mode host.** Codex routes shell tools through a host that embeds V8, and the rusty_v8 prebuilt for `aarch64-apple-darwin` is a 404 in this version. Copying the prebuilt host out of the `@openai/codex` npm platform package into `codex-rs/target/debug/codex-code-mode-host` works and is what the crash test above ran against.
- **A killed process can leave a thread locked.** The writer lock is an advisory `flock`, so the OS releases it when the process dies. It only blocks a resume while a process still holds it, which is why the panic above was so damaging: the panicking process stayed alive.
- **`codex exec` can still wait on a turn task that dies without saying so.** A panic is now turned into a turn failure, which is the cause that showed up in practice. The wait loop still only ends on an event or a closed stream, so any other silent death of the turn task would hang it, and the stall timeout above is what makes that survivable rather than fatal.
