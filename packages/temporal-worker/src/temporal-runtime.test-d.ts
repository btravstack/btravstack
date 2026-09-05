/**
 * The root's `unit` gate. A piece's `unit:` record is a promise the ROOT has to
 * keep: `context.unit.tenant` resolves out of the fork, so the bound
 * `unit.activity` module must export `Tenant` or the read defects at the first
 * attempt. Nothing else checks it — the piece and the root are typed
 * independently — so this is the gate, and each negative below is the assertion
 * that it still fires.
 *
 * Its own contract rather than `test-fixtures.js`'s: that module pulls in
 * `@unthrown/vitest`'s matcher augmentation, which this file's own
 * `tsconfig.test-d.json` — `src/**\/*.test-d.ts` only — never loads.
 */
import { start } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { OkAsync } from "unthrown";
import { z } from "zod";

import { TemporalActivities, TemporalModule } from "./temporal-module.js";
import { ActivityInput, TemporalWorkflowActivities } from "./workflow-activities.js";

const step = defineActivity({
  input: z.string(),
  output: z.string(),
  activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
});

const pinContract = defineContract({
  taskQueue: "pin-unit",
  workflows: {
    runEcho: defineWorkflow({
      input: z.string(),
      output: z.string(),
      startPolicy: "allow-duplicate",
      activities: { echo: step },
    }),
  },
});

const workflows = { workflowsPath: "./nowhere.js" };

const Input = ActivityInput(pinContract);
class Tenant extends Port("PinTenant")<{ readonly id: string }> {}
class Elsewhere extends Port("PinElsewhere")<{ readonly n: number }> {}

const TenantUnit = Module("PinTenantUnit")({
  needs: [Input],
  provides: [Provider(Tenant)({ inject: { input: Input }, sync: ({ input }) => ({ id: input }) })],
  exports: [Tenant],
});

const ElsewhereUnit = Module("PinElsewhereUnit")({
  provides: [Provider(Elsewhere)({ inject: {}, value: { n: 1 } })],
  exports: [Elsewhere],
});

const scopedPiece = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({
  inject: {},
  unit: { tenant: Tenant },
  sync: () => ({
    echo: ({ context, input }) => OkAsync(`${context.unit.tenant.id}:${input}`),
  }),
});
const scopedActivities = TemporalActivities(pinContract)([scopedPiece]);

// Positive, and two assertions in one: the bound module exports what the piece
// injects, so the gate clears — and `start` accepts the root, so the module's
// own `needs: [ActivityInput(contract)]` never surfaced as an unmet need. The
// fork's seed is what discharges it, and `UnitNeedsOf` subtracts it for that
// reason; without the subtraction this line would be the failure.
const _seedIsNotANeed = start(
  TemporalModule("PinUnitSatisfied")({
    contract: pinContract,
    activities: scopedActivities,
    workflows,
    provides: [scopedPiece],
    unit: { activity: TenantUnit },
  }),
  { signals: false, probes: false },
);
void _seedIsNotANeed;

const _wrongUnit = {
  contract: pinContract,
  activities: scopedActivities,
  workflows,
  provides: [scopedPiece],
  unit: { activity: ElsewhereUnit },
} as const;
// @ts-expect-error -- UNIT DOES NOT PROVIDE: `ElsewhereUnit` exports no `Tenant`
TemporalModule("PinUnitWrong")(_wrongUnit);

const _noUnit = {
  contract: pinContract,
  activities: scopedActivities,
  workflows,
  provides: [scopedPiece],
} as const;
// @ts-expect-error -- UNIT DOES NOT PROVIDE: nothing is bound, so `Tenant` is nowhere
TemporalModule("PinUnitUnbound")(_noUnit);

// The RECORD arm declares `unit:` too, and it reaches the root's gate exactly
// as a piece's does: `sync` sees `context.unit` typed by what the record
// declared, and `_declaredUnit` carries it to `TemporalModule`.
const recordActivities = TemporalActivities(pinContract)({
  inject: {},
  unit: { tenant: Tenant },
  sync: () => ({
    runEcho: { echo: ({ context, input }) => OkAsync(`${context.unit.tenant.id}:${input}`) },
  }),
});

// Negative: a name the record did not declare is not on `context.unit` at all.
TemporalActivities(pinContract)({
  inject: {},
  unit: { tenant: Tenant },
  sync: () => ({
    runEcho: {
      echo: ({ context, input }) => {
        // @ts-expect-error -- `user` is no name this record declared on `unit`
        void context.unit.user;
        return OkAsync(input);
      },
    },
  }),
});

// Positive: the bound module exports what the record arm declared, so the gate
// clears — the record arm's own half of the pair the pieces pin above.
const _recordUnitSatisfied = start(
  TemporalModule("PinRecordUnitSatisfied")({
    contract: pinContract,
    activities: recordActivities,
    workflows,
    unit: { activity: TenantUnit },
  }),
  { signals: false, probes: false },
);
void _recordUnitSatisfied;

const _wrongRecordUnit = {
  contract: pinContract,
  activities: recordActivities,
  workflows,
  unit: { activity: ElsewhereUnit },
} as const;
// @ts-expect-error -- UNIT DOES NOT PROVIDE: `ElsewhereUnit` exports no `Tenant`
TemporalModule("PinRecordUnitWrong")(_wrongRecordUnit);

// Positive: a root whose pieces declare no `unit:` is gated on nothing, bound
// module or not — which is what keeps `examples/order-temporal-worker` compiling.
const plainPiece = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({ inject: {}, sync: () => ({ echo: ({ input }) => OkAsync(input) }) });
TemporalModule("PinUnitUndeclared")({
  contract: pinContract,
  activities: TemporalActivities(pinContract)([plainPiece]),
  workflows,
  provides: [plainPiece],
  unit: { activity: ElsewhereUnit },
});
