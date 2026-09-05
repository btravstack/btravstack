import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { ConfigInvalid, Environment } from "@btravstack/config";
import {
  Observers,
  currentUnit,
  type Attributes,
  type Operation,
  type RunningApp,
  type Settle,
  type UnitRecord,
} from "@btravstack/core";
import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import { createNamespace } from "@btravstack/internal-test-infra/namespace";
import { bootFixture, type Boot } from "@btravstack/testing";
import { TypedClient } from "@temporal-contract/client";
import {
  defineActivity,
  defineContract,
  defineWorkflow,
  type ContractDefinition,
} from "@temporal-contract/contract";
import { Client, Connection, type ScheduleSpec } from "@temporalio/client";
import type { Duration } from "@temporalio/common";
import { OkAsync, fromSafePromise } from "unthrown";
import { inject, test } from "vitest";
import { z } from "zod";

import { ensureSchedule } from "../schedule.js";
import { TemporalActivities, TemporalModule } from "../temporal-module.js";
import {
  TemporalConfig,
  type AnyUnitModule,
  type TemporalInfo,
  type TemporalUnreachable,
  type WorkflowSource,
} from "../temporal-runtime.js";
import { ActivityInput, TemporalWorkflowActivities } from "../workflow-activities.js";

/**
 * One Temporal server for the whole repository, with a namespace of this spec
 * file's own on it — Temporal's own isolation boundary, and enough here because
 * nothing in this suite advances a clock.
 */
type Server = { readonly address: string; readonly namespace: string };

export class Greeting extends Port("Greeting")<{ readonly text: string }> {}

/**
 * The smallest contract that exercises the seam: one workflow, one activity,
 * whose flat runtime name is what `test-workflows.ts` proxies.
 */
const echoContract = defineContract({
  taskQueue: "echo",
  workflows: {
    runEcho: defineWorkflow({
      input: z.string(),
      output: z.string(),
      startPolicy: "allow-duplicate",
      activities: {
        echo: defineActivity({
          input: z.string(),
          output: z.string(),
          activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
        }),
      },
    }),
  },
});

/** The activities provider builder as a consumer gets it, typed for the contract. */
const EchoActivities = TemporalActivities(echoContract);

const echoing = EchoActivities({
  inject: {},
  sync: () => ({ runEcho: { echo: ({ input }) => OkAsync(input) } }),
});

/**
 * An activity whose failure nobody modelled — a defect, which Temporal turns
 * into an application failure. The errors half of RED has to see it: a count
 * that omitted defects would report a healthy rate while every attempt failed.
 */
const failingEcho = EchoActivities({
  inject: {},
  sync: () => ({
    runEcho: {
      echo: () => fromSafePromise(Promise.reject<string>(new Error("the activity is on fire"))),
    },
  }),
});

/**
 * An activity the contract never declared. Built as a variable, not a literal
 * in the provider call, so it reaches `declareActivitiesHandler` — which
 * rejects it at startup — instead of the excess-property check.
 */
const undeclaredEcho = {
  runEcho: {
    echo: ({ input }: { input: string }) => OkAsync(input),
    undeclared: () => OkAsync(undefined),
  },
};
export const undeclared = EchoActivities({ inject: {}, sync: () => undeclaredEcho });

/**
 * The activities built from a service they close over, recording what they saw.
 * `seen` reads the ambient record from inside the attempt — `undefined` outside
 * a unit, so its length is the unit count.
 */
const contractSeamOf = () => {
  const seen: (UnitRecord | undefined)[] = [];
  let greeting = "";

  return {
    activities: EchoActivities({
      inject: { greeting: Greeting },
      sync: ({ greeting: service }) => ({
        runEcho: {
          echo: ({ input: value }) => {
            seen.push(currentUnit());
            greeting = service.text;
            return OkAsync(value);
          },
        },
      }),
    }),
    seen: (): readonly (UnitRecord | undefined)[] => seen,
    greeting: (): string => greeting,
  };
};

/**
 * An activity that waits on the kernel's per-unit signal, reached through
 * `currentUnit()`, and reports what it saw. `arrived` is the moment the attempt
 * reached it, so a drain spec knows the unit is genuinely in flight.
 */
const deadlineOf = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let sawAbort: boolean | undefined;

  return {
    activities: EchoActivities({
      inject: {},
      sync: () => ({
        runEcho: {
          echo: ({ input: value }) => {
            const signal = currentUnit()?.signal;
            entered();
            return fromSafePromise(
              new Promise<string>((done) => {
                // No record at all is the regression this fixture exists to
                // catch: settle at once, so the spec fails on `sawAbort` rather
                // than hanging until the suite's timeout.
                if (signal === undefined) {
                  sawAbort = false;
                  done(value);
                  return;
                }
                // An already-aborted signal never fires `abort` again, which is
                // why a drain deadline of `0` would otherwise strand this.
                if (signal.aborted) {
                  sawAbort = true;
                  done(value);
                  return;
                }
                signal.addEventListener(
                  "abort",
                  () => {
                    sawAbort = true;
                    done(value);
                  },
                  { once: true },
                );
              }),
            );
          },
        },
      }),
    }),
    arrived,
    sawAbort: (): boolean | undefined => sawAbort,
  };
};

/**
 * The same wiring, but the activity resolves only once `release()` is called and
 * reports its arrival through `arrived` — the drain specs turn on knowing a unit
 * is genuinely in flight before the drain starts.
 */
const gateOf = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    activities: EchoActivities({
      inject: {},
      sync: () => ({
        runEcho: {
          echo: ({ input: value }) => {
            entered();
            return fromSafePromise(held.then(() => value));
          },
        },
      }),
    }),
    arrived,
    release: (): void => release(),
  };
};

/**
 * Captures the `TemporalConfig` the graph actually bound, so the starter's
 * three configuration specs can assert on it without a probe of their own.
 */
const configuredOf = () => {
  let bound: ServiceOf<TemporalConfig> | undefined;
  return {
    tap: Provider(BoundConfig)({
      inject: { config: TemporalConfig },
      sync: ({ config }) => {
        bound = config;
        return config;
      },
    }),
    bound: (): ServiceOf<TemporalConfig> | undefined => bound,
  };
};

class BoundConfig extends Port("BoundConfig")<ServiceOf<TemporalConfig>> {}

/**
 * Two workflows, one task queue — a worker whose activities are composed from
 * one slice per workflow, which is what a sliced worker is.
 */
const slicedContract = defineContract({
  taskQueue: "sliced",
  workflows: {
    runEcho: defineWorkflow({
      input: z.string(),
      output: z.string(),
      startPolicy: "allow-duplicate",
      activities: {
        echo: defineActivity({
          input: z.string(),
          output: z.string(),
          activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
        }),
      },
    }),
    runShout: defineWorkflow({
      input: z.string(),
      output: z.string(),
      startPolicy: "allow-duplicate",
      activities: {
        shout: defineActivity({
          input: z.string(),
          output: z.string(),
          activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
        }),
      },
    }),
  },
});

/**
 * Two slices, composed. `runEcho`'s piece declares `Greeting` and `runShout`'s
 * declares nothing, so a spec can tell each was built from the ports its OWN
 * provider declared.
 *
 * `pieces` is exposed alongside `activities` because the composed provider's
 * `deps` are the pieces' PORTS: something still has to REGISTER them, since
 * `flatten` never collects a provider's deps transitively.
 */
const slicesOf = () => {
  let greeting = "";
  const units: (readonly string[])[] = [];
  const echo = TemporalWorkflowActivities(
    slicedContract,
    "runEcho",
  )({
    inject: { greeting: Greeting },
    sync: ({ greeting: service }) => ({
      echo: ({ input: value }) => {
        greeting = service.text;
        return OkAsync(value);
      },
    }),
  });
  const shout = TemporalWorkflowActivities(
    slicedContract,
    "runShout",
  )({
    inject: {},
    sync: () => ({
      shout: ({ context, input }) => {
        units.push(Object.keys(context.unit));
        return OkAsync(input.toUpperCase());
      },
    }),
  });
  return {
    activities: TemporalActivities(slicedContract)([echo, shout]),
    pieces: [echo, shout] as const,
    greeting: (): string => greeting,
    /** What `runShout`'s piece found on `context.unit` — nothing declared, no module bound. */
    units: (): readonly (readonly string[])[] => units,
  };
};

export class Tenant extends Port("Tenant")<{ readonly id: string }> {}

/**
 * One workflow and one contract-global activity on a queue of their own. The
 * workflow drives both, which is what makes the seeded fork's two ENTRY SHAPES
 * — a workflow key's record of implementations and a global key's bare
 * implementation — run in the same attempt pair.
 */
const scopedContract = defineContract({
  taskQueue: "scoped",
  activities: {
    audit: defineActivity({
      input: z.string(),
      output: z.string(),
      activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
    }),
  },
  workflows: {
    runAudited: defineWorkflow({
      input: z.string(),
      output: z.string(),
      startPolicy: "allow-duplicate",
      activities: {
        echo: defineActivity({
          input: z.string(),
          output: z.string(),
          activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
        }),
      },
    }),
  },
});

/** The invocation's own port, as a unit module reads it: one seed, typed by the contract. */
const ScopedInput = ActivityInput(scopedContract);

/**
 * The seeded fork, end to end: an `activity` module deriving a tenant from the
 * validated input, and two pieces declaring it — so what an activity reads off
 * `context.unit.tenant` can only have come through the seed.
 */
const TenantUnitModule = Module("TenantUnit")({
  needs: [ScopedInput],
  provides: [
    Provider(Tenant)({ inject: { input: ScopedInput }, sync: ({ input }) => ({ id: input }) }),
  ],
  exports: [Tenant],
});

const scopedOf = () => {
  const seen: string[] = [];
  const module = TenantUnitModule;

  const audited = TemporalWorkflowActivities(
    scopedContract,
    "runAudited",
  )({
    inject: {},
    unit: { tenant: Tenant },
    sync: () => ({
      echo: ({ context, input }) => {
        seen.push(`echo:${context.unit.tenant.id}`);
        return OkAsync(input);
      },
    }),
  });
  const audit = TemporalWorkflowActivities(
    scopedContract,
    "audit",
  )({
    inject: {},
    unit: { tenant: Tenant },
    sync:
      () =>
      ({ context, input }) => {
        seen.push(`audit:${context.unit.tenant.id}`);
        return OkAsync(input);
      },
  });

  return {
    module,
    pieces: [audited, audit] as const,
    activities: TemporalActivities(scopedContract)([audited, audit]),
    seen: (): readonly string[] => seen,
  };
};

/**
 * The same seeded fork through the WHOLE-RECORD arm: one `unit:` for every
 * entry in the record — both of `withUnit`'s shapes, a workflow's record and a
 * contract-global implementation — and no piece for the root to provide.
 */
const wholeScopedOf = () => {
  const seen: string[] = [];
  return {
    module: TenantUnitModule,
    pieces: [] as const,
    activities: TemporalActivities(scopedContract)({
      inject: {},
      unit: { tenant: Tenant },
      sync: () => ({
        runAudited: {
          echo: ({ context, input }) => {
            seen.push(`echo:${context.unit.tenant.id}`);
            return OkAsync(input);
          },
        },
        audit: ({ context, input }) => {
          seen.push(`audit:${context.unit.tenant.id}`);
          return OkAsync(input);
        },
      }),
    }),
    seen: (): readonly string[] => seen,
  };
};

type App = RunningApp<ConfigInvalid | TemporalUnreachable, TemporalInfo>;

let queueSeq = 0;
const nextTaskQueue = (): string => `t-${(queueSeq += 1)}-${process.pid}`;

/**
 * `contract` with a per-test `taskQueue`, typed as `C` rather than the widened
 * literal an inline spread produces — which is what lets `TemporalModule` infer
 * ONE `C` from `contract` and `activities` together.
 */
const withTaskQueue = <C extends ContractDefinition>(contract: C, taskQueue: string): C =>
  ({ ...contract, taskQueue }) as C;

const echoWorkflows: WorkflowSource = {
  workflowsPath: fileURLToPath(new URL("../test-workflows.ts", import.meta.url)),
};
const missingWorkflows: WorkflowSource = {
  workflowsPath: fileURLToPath(new URL("../does-not-exist.js", import.meta.url)),
};

type ActivitiesProvider = typeof echoing | ReturnType<typeof contractSeamOf>["activities"];

/** What a spec may vary: the activities, the starter's pins, the environment, the kernel's drain budget. */
type BootOptions = {
  readonly activities?: ActivitiesProvider;
  readonly address?: string;
  readonly namespace?: string;
  readonly gracePeriod?: Duration;
  readonly env?: Environment;
  readonly workflows?: WorkflowSource;
  readonly drainTimeoutMs?: number;
  readonly tap?: ReturnType<typeof configuredOf>["tap"];
  readonly unit?: AnyUnitModule;
};

class CountingMark extends Port("CountingMark")<{ readonly at: number }> {}

/** A unit module that counts its builds and teardowns, for the fork's own tests. */
const countingUnit = (): {
  readonly module: Module<CountingMark, never, Scope>;
  readonly counts: () => { readonly builds: number; readonly stops: number };
} => {
  const counts = { builds: 0, stops: 0 };
  const module = Module("CountingUnit")({
    provides: [
      Provider(CountingMark)({
        inject: {},
        sync: () => {
          counts.builds += 1;
          return { at: counts.builds };
        },
        onStop: () => {
          counts.stops += 1;
        },
      }),
    ],
    exports: [CountingMark],
  });
  return { module, counts: () => counts };
};

export type TemporalFixtures = {
  /** Where the shared server is, and the namespace this spec file owns on it. */
  readonly server: Server;
  /** A client bound to {@link server}'s namespace. */
  readonly client: Client;
  readonly serve: (options?: BootOptions) => Promise<{
    readonly app: App;
    readonly client: Client;
    readonly taskQueue: string;
  }>;
  readonly serveBroken: (options?: BootOptions) => Promise<App>;
  /** The starter served over an observer that records what it was handed. */
  readonly serveObserved: (failing?: boolean) => Promise<{
    readonly app: App;
    readonly client: Client;
    readonly taskQueue: string;
    readonly taken: () => readonly Observation[];
  }>;
  /** `ensureSchedule` over this test's own schedule id. */
  readonly schedules: Awaited<ReturnType<typeof schedulesOf>>;
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  readonly contractSeam: ReturnType<typeof contractSeamOf>;
  readonly gate: ReturnType<typeof gateOf>;
  /** An activity that waits on the unit's own `AbortSignal`, read off the ambient record. */
  readonly deadline: ReturnType<typeof deadlineOf>;
  readonly configured: ReturnType<typeof configuredOf>;
  readonly slices: ReturnType<typeof slicesOf>;
  readonly serveSliced: (slices: ReturnType<typeof slicesOf>) => Promise<{
    readonly app: App;
    readonly client: Client;
    readonly taskQueue: string;
  }>;
  /** The seeded fork end to end: a tenant derived from the input, read off `context.unit`. */
  readonly scoped: ReturnType<typeof scopedOf>;
  /** The same seed read through the whole-record arm's own `unit:`, no piece involved. */
  readonly wholeScoped: ReturnType<typeof wholeScopedOf>;
  readonly serveScoped: (
    scoped: ReturnType<typeof scopedOf> | ReturnType<typeof wholeScopedOf>,
  ) => Promise<{
    readonly app: App;
    readonly client: Client;
    readonly taskQueue: string;
  }>;
  /** A unit module counting its builds and teardowns, to bind on `serve`'s `unit`. */
  readonly counting: ReturnType<typeof countingUnit>;
};

/**
 * One booted application, composed the way a composition root composes it and
 * started against this file's own namespace — so every test opens and closes a
 * connection of its own.
 */
/** One observed operation, as an observer saw it settle. */
export type Observation = {
  readonly component: string;
  readonly name: string;
  readonly attributes: Attributes;
  readonly outcome: "ok" | "error";
};

/** An observer that keeps what it was handed, so a spec asserts on the DIMENSIONS. */
const recordingObserver = (): {
  member: (operation: Operation) => Settle;
  taken: () => readonly Observation[];
} => {
  const taken: Observation[] = [];
  return {
    member:
      ({ component, name, attributes }) =>
      ({ outcome, attributes: settled }) => {
        taken.push({ component, name, attributes: { ...attributes, ...settled }, outcome });
      },
    taken: () => taken,
  };
};

/** The starter over an observer that records — all a graph does to be observed. */
const composeObserved = (
  server: Server,
  boot: Boot,
  member: (operation: Operation) => Settle,
  failing: boolean,
) => {
  const taskQueue = nextTaskQueue();
  const worker = TemporalModule("Observed")({
    contract: { ...echoContract, taskQueue },
    activities: failing ? failingEcho : echoing,
    workflows: echoWorkflows,
    provides: [
      Provider(Greeting)({ inject: {}, value: { text: "hello" } }),
      Provider.member(Observers)({ inject: {}, value: member }),
    ],
  });
  const app: App = boot(worker, {
    env: { TEMPORAL_ADDRESS: server.address, TEMPORAL_NAMESPACE: server.namespace },
  });
  return { app, taskQueue };
};

const compose = (server: Server, boot: Boot, options: BootOptions) => {
  const taskQueue = nextTaskQueue();
  const worker = TemporalModule("Worker")({
    contract: { ...echoContract, taskQueue },
    activities: options.activities ?? echoing,
    workflows: options.workflows ?? echoWorkflows,
    ...(options.address === undefined ? {} : { address: options.address }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    ...(options.gracePeriod === undefined ? {} : { gracePeriod: options.gracePeriod }),
    // `as never`: `options.unit` is `AnyUnitModule`, whose own needs are
    // erased to `unknown` — passed through untyped it would poison
    // `TemporalModule`'s inferred `Unit` into an unsatisfiable `unknown` need
    // for every caller of this fixture, unit-bound test or not.
    unit: { activity: options.unit as never },
    provides: [
      Provider(Greeting)({ inject: {}, value: { text: "hello" } }),
      ...(options.tap === undefined ? [] : [options.tap]),
    ],
  });
  const app: App = boot(worker, {
    env: options.env ?? { TEMPORAL_ADDRESS: server.address, TEMPORAL_NAMESPACE: server.namespace },
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
  });
  return { app, taskQueue };
};

/**
 * `ensureSchedule` bound to this test's own namespace and a schedule id nobody
 * else uses, so the suite needs no cleanup — the namespace is what disposes.
 */
const schedulesOf = async (client: Client, contract: typeof echoContract) => {
  const scheduleId = `sched-${randomUUID()}`;
  const schedules = (await TypedClient.create({ client })).get().for(contract).schedule;
  return {
    ensure: (spec: ScheduleSpec, args = "x") =>
      ensureSchedule(schedules, "runEcho", { scheduleId, spec, args }),
    // The two pass-through arms, reached past the types: a workflow the
    // contract does not declare, and args its schema refuses.
    ensureUnknown: (spec: ScheduleSpec) =>
      ensureSchedule(schedules, "nope" as "runEcho", { scheduleId, spec, args: "x" }),
    ensureInvalid: (spec: ScheduleSpec) =>
      ensureSchedule(schedules, "runEcho", { scheduleId, spec, args: 1 as unknown as string }),
    describe: () => schedules.getHandle(scheduleId).describe(),
  };
};

export const it = test.extend<TemporalFixtures>({
  server: [
    // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
    async ({}, use) => {
      const address = `${inject("__TESTCONTAINERS_TEMPORAL_IP__")}:${inject("__TESTCONTAINERS_TEMPORAL_PORT_7233__")}`;
      await use({ address, namespace: await createNamespace(address, "temporal-pkg") });
    },
    // Per FILE, not per test: registering a namespace costs a registry refresh
    // on every Temporal service, while a task queue per test (which `compose`
    // already mints) is what separates the tests inside one file.
    { scope: "file" },
  ],
  client: async ({ server }, use) => {
    const connection = await Connection.connect({ address: server.address });
    const client = new Client({ connection, namespace: server.namespace });
    // Closed after `serve`/`serveBroken` stopped their apps — a fixture's
    // cleanup runs in reverse dependency order.
    await use(client);
    await connection.close();
  },
  boot: bootFixture(),
  serve: async ({ server, client, boot }, use) => {
    await use(async (options = {}) => {
      const { app, taskQueue } = compose(server, boot, options);
      await app.runtimeInfo();
      return { app, client, taskQueue };
    });
  },
  serveObserved: async ({ server, client, boot }, use) => {
    await use(async (failing = false) => {
      const observer = recordingObserver();
      const { app, taskQueue } = composeObserved(server, boot, observer.member, failing);
      await app.runtimeInfo();
      return { app, client, taskQueue, taken: observer.taken };
    });
  },
  schedules: async ({ client }, use) => {
    await use(await schedulesOf(client, echoContract));
  },
  serveBroken: async ({ server, boot }, use) => {
    // A failure under test is served against a workflow module that exists, so
    // it is the only failure available; with nothing under test the module is
    // the failure.
    await use((options = {}) => {
      const { app } = compose(server, boot, {
        workflows:
          options.activities === undefined && options.env === undefined
            ? missingWorkflows
            : echoWorkflows,
        ...options,
      });
      return Promise.resolve(app);
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  contractSeam: async ({}, use) => {
    await use(contractSeamOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    const gate = gateOf();
    await use(gate);
    // Released on every exit path, so an activity a test deliberately stranded
    // cannot outlive the test that stranded it.
    gate.release();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  deadline: async ({}, use) => {
    await use(deadlineOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  configured: async ({}, use) => {
    await use(configuredOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  slices: async ({}, use) => {
    await use(slicesOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  scoped: async ({}, use) => {
    await use(scopedOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  wholeScoped: async ({}, use) => {
    await use(wholeScopedOf());
  },
  serveScoped: async ({ server, client, boot }, use) => {
    await use(async (scoped) => {
      const taskQueue = nextTaskQueue();
      const app: App = boot(
        TemporalModule("Scoped")({
          contract: withTaskQueue(scopedContract, taskQueue),
          activities: scoped.activities,
          workflows: echoWorkflows,
          provides: [...scoped.pieces],
          unit: { activity: scoped.module },
        }),
        { env: { TEMPORAL_ADDRESS: server.address, TEMPORAL_NAMESPACE: server.namespace } },
      );
      await app.runtimeInfo();
      return { app, client, taskQueue };
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  counting: async ({}, use) => {
    await use(countingUnit());
  },
  serveSliced: async ({ server, client, boot }, use) => {
    await use(async (slices) => {
      const taskQueue = nextTaskQueue();
      const app: App = boot(
        TemporalModule("Sliced")({
          contract: withTaskQueue(slicedContract, taskQueue),
          activities: slices.activities,
          workflows: echoWorkflows,
          // The composed provider's own deps are the pieces' PORTS — see
          // `slicesOf`'s comment — so the pieces themselves are what discharge
          // them, same as any other unmet need.
          provides: [
            ...slices.pieces,
            Provider(Greeting)({ inject: {}, value: { text: "hello" } }),
          ],
        }),
        { env: { TEMPORAL_ADDRESS: server.address, TEMPORAL_NAMESPACE: server.namespace } },
      );
      await app.runtimeInfo();
      return { app, client, taskQueue };
    });
  },
});
