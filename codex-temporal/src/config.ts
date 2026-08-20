// Temporal + Codex wiring, read from env. The workflow never reads this (workflow code must stay
// deterministic); the client and the worker do.

export interface Config {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  // Codex's home. Holds the rollout logs and the per-thread writer locks.
  readonly codexHome: string;
  // Where Codex keeps its rollout logs. That directory is the durable record, so a fleet points
  // it at shared storage.
  readonly sessionsDir: string;
  readonly idleTimeout: string;
  // Which codex binary to drive. Defaults to whatever the SDK finds; point it at a fork build to
  // drive that instead.
  readonly codexPath?: string;
  readonly model?: string;
  readonly projectDir: string;
  // Codex's own sandbox setting for the turn. Left to the caller because a durable executor
  // running unattended is exactly where you want to be deliberate about it.
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  // How long a turn may produce no events before its codex is killed and the turn re-driven.
  // Long enough for a slow tool, short enough that a hung codex does not pin the workflow.
  readonly stallTimeoutMs: number;
}

export function fromEnv(): Config {
  const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
  return {
    codexHome,
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: process.env.CODEX_TEMPORAL_TASK_QUEUE ?? "codex-thread",
    sessionsDir: process.env.CODEX_SESSIONS_DIR ?? `${codexHome}/sessions`,
    idleTimeout: process.env.CODEX_IDLE_TIMEOUT ?? "5 minutes",
    codexPath: process.env.CODEX_PATH,
    model: process.env.CODEX_MODEL,
    projectDir: process.env.CODEX_PROJECT_DIR ?? process.cwd(),
    sandboxMode: (process.env.CODEX_SANDBOX as Config["sandboxMode"]) ?? "workspace-write",
    stallTimeoutMs: Number(process.env.CODEX_STALL_TIMEOUT_MS ?? 10 * 60_000),
  };
}
