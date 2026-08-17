import { proxyActivities } from "@temporalio/workflow";

const { echo } = proxyActivities<{ echo: (value: string) => Promise<string> }>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

/** The suite's first workflow: it exists to make one activity attempt happen. */
export const runEcho = async (value: string): Promise<string> => echo(value);

const { shout } = proxyActivities<{ shout: (value: string) => Promise<string> }>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

/** A second workflow, so the suite can compose two slices onto one task queue. */
export const runShout = async (value: string): Promise<string> => shout(value);
