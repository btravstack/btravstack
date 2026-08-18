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

// Negative: a piece built for ANOTHER contract is refused — the port's id
// carries only the key, so what separates the two is the SERVICE it carries:
// that contract's activities record for that key. `otherStep` therefore has a
// genuinely different input and output, not a second copy of `step` — di's
// port typing is structural on id and service, so reusing `step` here would
// make the two `runEcho` pieces the same type and this assertion would report
// nothing to catch. (`packages/amqp`'s mirror of this gate needed exactly that
// fix: its first version shared one message shape and the directive sat
// unused.)
//
// Verified rather than assumed, because the raw diagnostic is misleading: with
// the directive stripped, TypeScript reports `"…:runEcho" is not assignable to
// "…:runShout"`, which reads like a positional complaint about the array. It
// is not — that is one arm of the `PieceOf<C>` union being printed. The
// discriminating experiment is a third contract whose `runEcho` reuses `step`
// unchanged: composed into the same position of the same array, it is
// ACCEPTED. So what this line pins really is the service the port carries.
const otherStep = defineActivity({
  input: z.number(),
  output: z.number(),
  activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
});
const otherContract = defineContract({
  taskQueue: "pin-other",
  workflows: {
    runEcho: defineWorkflow({
      input: z.number(),
      output: z.number(),
      idempotency: "allow-duplicate",
      activities: { echo: otherStep },
    }),
  },
});
const otherEcho = TemporalWorkflowActivities(
  otherContract,
  "runEcho",
)({
  value: { echo: (value) => OkAsync(value) },
});
// @ts-expect-error -- built for `otherContract`, whose `runEcho` activities take and answer a number
TemporalActivities(pinContract)([otherEcho, shout, audit]);

// Positive: the two existing arms still resolve, unchanged.
TemporalActivities(pinContract)({
  value: {
    runEcho: { echo: (value) => OkAsync(value) },
    runShout: { shout: (value) => OkAsync(value) },
    audit: (value) => OkAsync(value),
  },
});
