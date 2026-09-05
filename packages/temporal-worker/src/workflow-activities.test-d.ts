/**
 * The composing form's gates, all compile-time. A piece is typed by the one
 * top-level key of the activities record it names — a workflow's whole
 * activities record, or a contract-global activity.
 */
import { Env } from "@btravstack/config";
import { Port } from "@btravstack/di";
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
      startPolicy: "allow-duplicate",
      activities: { echo: step },
    }),
    runShout: defineWorkflow({
      input: z.string(),
      output: z.string(),
      startPolicy: "allow-duplicate",
      activities: { shout: step },
    }),
  },
});

class Tenant extends Port("PinSliceTenant")<{ readonly id: string }> {}

const echo = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({ inject: {}, sync: () => ({ echo: ({ input }) => OkAsync(input) }) });
const shout = TemporalWorkflowActivities(
  pinContract,
  "runShout",
)({ inject: {}, sync: () => ({ shout: ({ input }) => OkAsync(input) }) });
// A contract-global activity is a top-level key of the record too, so the same
// builder builds it — the name is imprecise here, and that is documented.
const audit = TemporalWorkflowActivities(
  pinContract,
  "audit",
)({
  inject: {},
  sync:
    () =>
    ({ input }) =>
      OkAsync(input),
});

// Positive: the piece carries the port it was minted under, typed for its key.
const _echoPort: WorkflowActivitiesPortOf<typeof pinContract, "runEcho"> = echo.port;

// Positive: an array covering every key composes, and `TemporalModule` takes it.
const composed = TemporalActivities(pinContract)([echo, shout, audit]);
// The pieces are provided too: composing them into one provider makes the
// composed provider depend on their PORTS, which a root that names no slice
// still owes — the `needs` gate says so at this call.
TemporalModule("Pin")({
  contract: pinContract,
  activities: composed,
  provides: [echo, shout, audit],
  workflows: { workflowsPath: "./nowhere.js" },
  needs: [Env],
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
// nothing to catch. (`packages/amqp-worker`'s mirror of this gate needed exactly that
// fix: its first version shared one message shape and the directive sat
// unused.)
//
// Verified rather than assumed, because the raw diagnostic is misleading: with
// the directive stripped, TypeScript reports that this piece's `runEcho` port
// id is not assignable to `runShout`'s, which reads like a positional
// complaint about the array. It is not — that is one arm of the `PieceOf<C>`
// union being printed. The
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
      startPolicy: "allow-duplicate",
      activities: { echo: otherStep },
    }),
  },
});
const otherEcho = TemporalWorkflowActivities(
  otherContract,
  "runEcho",
)({ inject: {}, sync: () => ({ echo: ({ input }) => OkAsync(input) }) });
// @ts-expect-error -- built for `otherContract`, whose `runEcho` activities take and answer a number
TemporalActivities(pinContract)([otherEcho, shout, audit]);

// Positive: a piece declaring `unit:` reads those ports off `context.unit`,
// typed by the record it declared — one kind, so no narrowing to apply; what a
// name resolves to is the port's own service.
const scoped = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({
  inject: {},
  unit: { tenant: Tenant },
  sync: () => ({
    echo: ({ context, input }) => {
      const id: string = context.unit.tenant.id;
      void id;
      return OkAsync(input);
    },
  }),
});
void scoped.unit.tenant;

// Negative: a name the piece did not declare is not on the record at all, so
// reading it is TypeScript's own "property does not exist".
TemporalWorkflowActivities(
  pinContract,
  "runShout",
)({
  inject: {},
  unit: { tenant: Tenant },
  sync: () => ({
    shout: ({ context, input }) => {
      // @ts-expect-error -- `user` is no name this piece declared on `unit`
      void context.unit.user;
      return OkAsync(input);
    },
  }),
});

// Positive: the two existing arms still resolve, unchanged.
TemporalActivities(pinContract)({
  inject: {},
  value: {
    runEcho: { echo: ({ input }) => OkAsync(input) },
    runShout: { shout: ({ input }) => OkAsync(input) },
    audit: ({ input }) => OkAsync(input),
  },
});
