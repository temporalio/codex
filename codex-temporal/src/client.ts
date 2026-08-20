// Client helpers: submit a prompt to a thread (start the workflow if idle, then signal), read what
// the thread is doing, and interrupt it. The prompt rides a signal-with-start, so a first prompt
// starts the per-thread workflow and later prompts coalesce into the running one.

import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { fromEnv } from "./config.js";
import { QUERIES, SIGNALS, WORKFLOW_TYPE, workflowId } from "./protocol.js";
import type { PromptInput, ThreadOptions, ThreadState } from "./protocol.js";

export async function connect() {
  const cfg = fromEnv();
  const connection = await Connection.connect({ address: cfg.address });
  const client = new Client({ connection, namespace: cfg.namespace });
  return { cfg, client, connection };
}

export async function submitPrompt(sessionId: string, text: string, promptId = randomUUID()) {
  const { cfg, client, connection } = await connect();
  const prompt: PromptInput = { promptId, text };
  const options: ThreadOptions = { idleTimeout: cfg.idleTimeout };
  try {
    await client.workflow.signalWithStart(WORKFLOW_TYPE, {
      taskQueue: cfg.taskQueue,
      workflowId: workflowId(sessionId),
      args: [sessionId, options],
      signal: SIGNALS.submitPrompt,
      signalArgs: [prompt],
    });
  } finally {
    await connection.close();
  }
  return promptId;
}

export async function threadState(sessionId: string): Promise<ThreadState> {
  const { client, connection } = await connect();
  try {
    return await client.workflow.getHandle(workflowId(sessionId)).query<ThreadState, []>(QUERIES.threadState);
  } finally {
    await connection.close();
  }
}

export async function interrupt(sessionId: string) {
  const { client, connection } = await connect();
  try {
    await client.workflow.getHandle(workflowId(sessionId)).signal(SIGNALS.interrupt);
  } finally {
    await connection.close();
  }
}
