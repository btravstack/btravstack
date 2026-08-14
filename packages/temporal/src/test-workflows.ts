import { proxyActivities } from "@temporalio/workflow";

const { echo } = proxyActivities<{ echo: (value: string) => Promise<string> }>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

/** The suite's only workflow: it exists to make one activity attempt happen. */
export const runEcho = async (value: string): Promise<string> => echo(value);
