// Summarize a Codex rollout by thread id: how many of our prompts it holds, the tool-call balance,
// and the last answer. The tool balance is what a crash shows up in.
import { fromEnv } from "./src/config.js";
import { findRollout, summarize } from "./src/rollout.js";

const threadId = process.argv[2];
const cfg = fromEnv();
const path = await findRollout(cfg.sessionsDir, threadId);
if (!path) {
  console.error(`no rollout for thread ${threadId} under ${cfg.sessionsDir}`);
  process.exit(1);
}
console.log(JSON.stringify({ path, ...(await summarize(path)) }));
process.exit(0);
