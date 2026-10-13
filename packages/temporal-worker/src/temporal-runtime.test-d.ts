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
import { Env } from "@btravstack/config";
import { HealthChecks, Logger, start } from "@btravstack/core";
import { Module, Port, Provider, type Context } from "@btravstack/di";
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

// A piece naming its own `fork` is gated against THAT module, at its own call,
// and leaves the root's gate nothing to check: no `unit.activity` is bound
// below, and the root still starts.
const forkedPiece = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({
  unit: { tenant: Tenant },
  fork: TenantUnit,
  sync: () => ({
    echo: ({ context, input }) => OkAsync(`${context.unit.tenant.id}:${input}`),
  }),
});
const _forkedPieceStarts = start(
  TemporalModule("PinForked")({
    contract: pinContract,
    activities: TemporalActivities(pinContract)([forkedPiece]),
    workflows,
    provides: [forkedPiece],
  }),
  { signals: false, probes: false },
);
void _forkedPieceStarts;

TemporalWorkflowActivities(
  pinContract,
  "runEcho",
  // @ts-expect-error -- UNIT DOES NOT PROVIDE: the piece's own `ElsewhereUnit` exports no `Tenant`
)({
  unit: { tenant: Tenant },
  fork: ElsewhereUnit,
  sync: () => ({ echo: ({ input }) => OkAsync(input) }),
});

// A `fork` that may be `undefined` falls back to `unit.activity` at runtime,
// so the root's gate still checks the declared ports: a root binding no
// worker-wide module is refused.
declare const maybeTenantUnit: typeof TenantUnit | undefined;
const maybeForkedPiece = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({
  unit: { tenant: Tenant },
  fork: maybeTenantUnit,
  sync: () => ({ echo: ({ input }) => OkAsync(input) }),
});
const _maybeForked = {
  contract: pinContract,
  activities: TemporalActivities(pinContract)([maybeForkedPiece]),
  workflows,
  provides: [maybeForkedPiece],
} as const;
// @ts-expect-error -- UNIT DOES NOT PROVIDE: the fallback arm reaches an unbound `unit.activity`
TemporalModule("PinMaybeForked")(_maybeForked);

// A piece's module owes what it does not provide, exactly as a bound
// `unit.activity` does: the root must supply it, and `start` names it.
class Ledger extends Port("PinLedger")<{ readonly owner: string }> {}
const LedgerUnit = Module("PinLedgerUnit")({
  provides: [
    Provider(Tenant)({ inject: { ledger: Ledger }, sync: ({ ledger }) => ({ id: ledger.owner }) }),
  ],
  exports: [Tenant],
});
const ledgerPiece = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({
  unit: { tenant: Tenant },
  fork: LedgerUnit,
  sync: () => ({ echo: ({ input }) => OkAsync(input) }),
});
const ledgerless = TemporalModule("PinLedgerless")({
  contract: pinContract,
  activities: TemporalActivities(pinContract)([ledgerPiece]),
  workflows,
  provides: [ledgerPiece],
});
// @ts-expect-error -- UNSATISFIED DEPENDENCIES: nothing provides "PinLedger", which the piece's module needs
start(ledgerless, { signals: false, probes: false });

const _ledgerSupplied = start(
  TemporalModule("PinLedgerSupplied")({
    contract: pinContract,
    activities: TemporalActivities(pinContract)([ledgerPiece]),
    workflows,
    provides: [ledgerPiece, Provider(Ledger)({ inject: {}, value: { owner: "acme" } })],
  }),
  { signals: false, probes: false },
);
void _ledgerSupplied;

// A piece's module reads no configuration, as `unit.activity` reads none.
const ConfiguringUnit = Module("PinConfiguringUnit")({
  provides: [Provider(Tenant)({ inject: { env: Env }, sync: () => ({ id: "env" }) })],
  exports: [Tenant],
});
const configuringPiece = TemporalWorkflowActivities(
  pinContract,
  "runEcho",
)({
  unit: { tenant: Tenant },
  fork: ConfiguringUnit,
  sync: () => ({ echo: ({ input }) => OkAsync(input) }),
});
const configuring = TemporalModule("PinConfiguring")({
  contract: pinContract,
  activities: TemporalActivities(pinContract)([configuringPiece]),
  workflows,
  provides: [configuringPiece],
});
// @ts-expect-error -- UNIT READS CONFIGURATION: the piece's module injects `Env`
start(configuring, { signals: false, probes: false });

// The RECORD arm declares `unit:` too, and it reaches the root's gate exactly
// as a piece's does: `sync` sees `context.unit` typed by what the record
// declared, and `_declaredUnit` carries it to `TemporalModule`.
const recordActivities = TemporalActivities(pinContract)({
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

const infrastructureBusiness = Port("InfrastructureBusiness")<string>;
const rootLogger = Provider(Logger)({ inject: {}, sync: () => null as never });
const infrastructureModule = Module("Infrastructure")({
  provides: [
    rootLogger,
    Provider(infrastructureBusiness)({ inject: {}, value: "business" }),
    Provider.member(HealthChecks)({
      inject: {},
      value: { name: "backend", timeoutMs: 100, check: () => OkAsync() },
    }),
  ],
  exports: [Logger, HealthChecks, infrastructureBusiness],
});
const nestedInfrastructure = Module("NestedInfrastructure")({
  imports: [infrastructureModule],
  exports: [infrastructureModule],
});
type ApplicationPorts<M> = M extends Module<infer X, infer _E, infer _N> ? X : never;
const bareRoot = TemporalModule("BareRoot")({
  contract: pinContract,
  activities: TemporalActivities(pinContract)([plainPiece]),
  provides: [plainPiece],
  workflows,
});
declare const bareContext: Context<ApplicationPorts<typeof bareRoot>>;
// @ts-expect-error -- an absent logger is not exported
bareContext.get(Logger);
// @ts-expect-error -- absent health checks are not exported
bareContext.get(HealthChecks);
const infrastructureRoot = TemporalModule("InfrastructureRoot")({
  contract: pinContract,
  activities: TemporalActivities(pinContract)([plainPiece]),
  provides: [plainPiece],
  workflows,
  imports: [nestedInfrastructure],
});
declare const infrastructureContext: Context<ApplicationPorts<typeof infrastructureRoot>>;
infrastructureContext.get(Logger);
infrastructureContext.get(HealthChecks);
// @ts-expect-error -- business ports remain explicit
infrastructureContext.get(infrastructureBusiness);
const ownInfrastructureRoot = TemporalModule("OwnInfrastructureRoot")({
  contract: pinContract,
  activities: TemporalActivities(pinContract)([plainPiece]),
  provides: [plainPiece, rootLogger],
  workflows,
});
declare const ownInfrastructureContext: Context<ApplicationPorts<typeof ownInfrastructureRoot>>;
ownInfrastructureContext.get(Logger);
const privateInfrastructure = Module("PrivateInfrastructure")({ provides: [rootLogger] });
const privateRoot = TemporalModule("PrivateRoot")({
  contract: pinContract,
  activities: TemporalActivities(pinContract)([plainPiece]),
  provides: [plainPiece],
  workflows,
  imports: [privateInfrastructure],
});
declare const privateContext: Context<ApplicationPorts<typeof privateRoot>>;
// @ts-expect-error -- private infrastructure is not exported
privateContext.get(Logger);
const businessRoot = TemporalModule("BusinessRoot")({
  contract: pinContract,
  activities: TemporalActivities(pinContract)([plainPiece]),
  provides: [plainPiece],
  workflows,
  imports: [infrastructureModule],
  exports: [infrastructureBusiness],
});
declare const businessContext: Context<ApplicationPorts<typeof businessRoot>>;
businessContext.get(infrastructureBusiness);
