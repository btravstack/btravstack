/**
 * The composing form's gates, all compile-time. A piece is typed by the one
 * top-level key of the activities record it names — a workflow's whole
 * activities record, or a contract-global activity.
 */
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { OkAsync } from "unthrown";
import { z } from "zod";

import { TemporalActivities, TemporalModule } from "./temporal-module.js";
import {
  TemporalWorkflowActivities,
  type WorkflowActivitiesPortOf,
} from "./workflow-activities.js";

const step = defineActivity({
  input: z.string(),
  output: z.string(),
  activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
});

const pinContract = defineContract({
  taskQueue: "pin",
  activities: { audit: step },
  workflows: {
    runEcho: defineWorkflow({
      input: z.string(),
      output: z.string(),
      idempotency: "allow-duplicate",
      activities: { echo: step },
    }),
    runShout: defineWorkflow({
      input: z.string(),
      output: z.string(),
      idempotency: "allow-duplicate",
      activities: { shout: step },
    }),
  },
});

const echo = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({
  value: { echo: (value) => OkAsync(value) },
});
const shout = TemporalWorkflowActivities(
  pinContract,
  "runShout",
)({
  value: { shout: (value) => OkAsync(value) },
});
// A contract-global activity is a top-level key of the record too, so the same
// builder builds it — the name is imprecise here, and that is documented.
const audit = TemporalWorkflowActivities(
  pinContract,
  "audit",
)({
  value: (value) => OkAsync(value),
});

// Positive: the piece carries the port it was minted under, typed for its key.
const _echoPort: WorkflowActivitiesPortOf<typeof pinContract, "runEcho"> = echo.port;

// Positive: an array covering every key composes, and `TemporalModule` takes it.
const composed = TemporalActivities(pinContract)([echo, shout, audit]);
TemporalModule("Pin")({
  contract: pinContract,
  activities: composed,
  workflows: { workflowsPath: "./nowhere.js" },
});

// Negative: a key the record does not have is refused at the piece's own call.
// @ts-expect-error -- "runWhisper" is not a key of this contract's activities record
TemporalWorkflowActivities(pinContract, "runWhisper");

// Negative: an array that misses a key is refused at the root.
// @ts-expect-error -- `runShout` and `audit` are uncovered
TemporalActivities(pinContract)([echo]);

// Positive: the two existing arms still resolve, unchanged.
TemporalActivities(pinContract)({
  value: {
    runEcho: { echo: (value) => OkAsync(value) },
    runShout: { shout: (value) => OkAsync(value) },
    audit: (value) => OkAsync(value),
  },
});
