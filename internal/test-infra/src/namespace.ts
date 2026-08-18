import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { Connection } from "@temporalio/client";
import { msToTs } from "@temporalio/common";

const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

/**
 * Registering a namespace is not the same as being able to use one: the
 * frontend, matching and history services each hold a namespace registry they
 * refresh on their own interval, so a `startWorkflow` issued the instant
 * `registerNamespace` returns fails with `NamespaceNotFound` for as long as a
 * stale cache lives. Polling a namespace-scoped **read** is what tells us the
 * registries have caught up — `describeNamespace` alone answers from the
 * frontend and is not enough.
 */
const untilUsable = async (connection: Connection, namespace: string): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      await connection.workflowService.countWorkflowExecutions({ namespace });
      return;
    } catch (cause) {
      if (Date.now() > deadline)
        // oxlint-disable-next-line unthrown/no-throw -- test setup, outside any Result boundary: a namespace that never becomes usable must fail the suite loudly rather than leave every test timing out one by one
        throw new Error(`Temporal namespace '${namespace}' never became usable`, { cause });
      await delay(POLL_MS);
    }
  }
};

/**
 * A namespace of this spec file's own on the shared server, ready to use by
 * the time it is returned.
 *
 * A namespace is Temporal's own isolation boundary — the vhost of this
 * transport. It is what lets several spec files, in several workspaces, share
 * one server without seeing each other's workflow executions, schedules or
 * task queues. Per **file** rather than per test: registration costs a
 * registry refresh, and a task queue per test (which both suites already
 * mint) is what separates tests inside one file.
 *
 * The retention period is the shortest Temporal accepts, since nothing here
 * outlives the run.
 */
export const createNamespace = async (address: string, prefix: string): Promise<string> => {
  const namespace = `${prefix}-${randomUUID()}`;
  const connection = await Connection.connect({ address });

  try {
    await connection.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: msToTs("1 day"),
    });
    await untilUsable(connection, namespace);
    return namespace;
  } finally {
    await connection.close();
  }
};
