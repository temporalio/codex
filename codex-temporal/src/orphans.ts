// Reaping a codex that outlived its worker.
//
// Codex holds an advisory lock on a thread for as long as it runs, so a worker killed outright
// leaves a child still holding it and the next attempt cannot resume that thread. The orphan does
// finish eventually and free the lock, but a retry should not have to wait for it.
//
// The test for "safe to kill" is narrow on purpose: the process must hold this thread's lock file
// AND have been reparented, which only happens once the worker that spawned it is gone. A codex
// being driven by another live worker fails that test and is left alone.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);

const LOCK_DIR = "thread-writer-locks";
const ORPHAN_PPID = 1;
const FREED_TIMEOUT_MS = 10_000;

const lockPath = (codexHome: string, threadId: string) =>
  join(codexHome, LOCK_DIR, `${threadId}.lock`);

/** Pids holding the lock file, or an empty list when nothing does (or lsof is unavailable). */
async function holders(path: string): Promise<number[]> {
  try {
    const { stdout } = await run("lsof", ["-t", path]);
    return stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // lsof exits non-zero when no process holds the file, which is the common case.
    return [];
  }
}

async function parentOf(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(pid)]);
    const ppid = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ReapResult {
  readonly killed: number[];
  /** Held by something still parented, so it is somebody else's live turn. Left alone. */
  readonly liveHolders: number[];
}

/** Kill any orphaned codex holding this thread's lock, and wait for the lock to come free. */
export async function reapOrphanedWriter(codexHome: string, threadId: string): Promise<ReapResult> {
  const path = lockPath(codexHome, threadId);
  const killed: number[] = [];
  const liveHolders: number[] = [];

  for (const pid of await holders(path)) {
    if ((await parentOf(pid)) !== ORPHAN_PPID) {
      liveHolders.push(pid);
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // Gone between the two calls, which is the outcome we wanted anyway.
    }
  }

  if (killed.length > 0) {
    const deadline = Date.now() + FREED_TIMEOUT_MS;
    while (Date.now() < deadline && (await holders(path)).length > 0) {
      await sleep(200);
    }
  }

  return { killed, liveHolders };
}
