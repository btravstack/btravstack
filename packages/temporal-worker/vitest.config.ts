import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // ONE Temporal server (and its PostgreSQL) for the whole repository,
      // reused across every workspace's run rather than a time-skipping test
      // server per vitest worker — see `internal/test-infra`. Each spec file
      // registers a namespace of its own on it.
      globalSetup: ["@btravstack/internal-test-infra/temporal"],
      // The image pull dominates a cold run.
      testTimeout: 60_000,
      hookTimeout: 180_000,
      // 86, not the shared 90, and each missing arm is one a REAL Temporal
      // worker cannot be made to take here: `activity-units.ts`'s
      // `workflowExecution?.workflowId ?? activityId` fallback needs an
      // activity invoked outside any workflow, and the defect arm of its
      // `tapFailure` needs `next()` to defect rather than fail. A stub worker
      // reaches them and would be measuring the stub. Raise this by finding a
      // real invocation that takes them, never by widening the exclude list.
      coverage: covered({ branches: 86 }, "src/test-workflows.ts"),
    },
  }),
);
