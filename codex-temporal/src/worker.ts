// The worker: hosts the codexThread workflow and the runTurn activity. Run one or many; they pull
// the same task queue, so any worker can drive any thread from the shared sessions directory.

import { fileURLToPath } from "node:url";
import { access, constants } from "node:fs/promises";
import { NativeConnection, Worker } from "@temporalio/worker";
import { fromEnv } from "./config.js";
import { makeActivities } from "./activities.js";

async function main() {
  const cfg = fromEnv();

  // Checked here rather than left to the first turn: a worker that cannot run codex should say so
  // on startup, not once per attempt inside somebody's workflow.
  if (cfg.codexPath) {
    await access(cfg.codexPath, constants.X_OK).catch(() => {
      throw new Error(`CODEX_PATH is not an executable file: ${cfg.codexPath}`);
    });
  }

  const connection = await NativeConnection.connect({ address: cfg.address });

  const worker = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: cfg.taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
    activities: makeActivities(cfg),
  });

  console.log(`codex-temporal worker on ${cfg.address} / ${cfg.namespace} / ${cfg.taskQueue}`);
  console.log(`codex: ${cfg.codexPath ?? "(from PATH)"}   project: ${cfg.projectDir}`);
  console.log(`sessions: ${cfg.sessionsDir}   sandbox: ${cfg.sandboxMode}`);
  console.log(`turn timeout: ${cfg.turnTimeout}   attempts per turn: ${cfg.maxAttempts}`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
