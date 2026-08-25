import { fileURLToPath } from "node:url";

import type { ConfigInvalid, Environment } from "@btravstack/config";
import { currentUnit, type RunningApp, type UnitRecord } from "@btravstack/core";
import { Port, Provider, type ServiceOf } from "@btravstack/di";
import { createNamespace } from "@btravstack/internal-test-infra/namespace";
import { bootFixture, type Boot } from "@btravstack/testing";
import {
  defineActivity,
  defineContract,
  defineWorkflow,
  type ContractDefinition,
} from "@temporal-contract/contract";
import { Client, Connection } from "@temporalio/client";
import { OkAsync, fromSafePromise } from "unthrown";
import { inject, test } from "vitest";
import { z } from "zod";

import { TemporalActivities, TemporalModule } from "../temporal-module.js";
import {
  TemporalConfig,
  type TemporalInfo,
  type TemporalUnreachable,
  type WorkflowSource,
} from "../temporal-runtime.js";
import { TemporalWorkflowActivities } from "../workflow-activities.js";

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
      idempotency: "allow-duplicate",
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
  value: { runEcho: { echo: (value) => OkAsync(value) } },
});

/**
 * An activity the contract never declared. Built as a variable, not a literal
 * in the provider call, so it reaches `declareActivitiesHandler` — which
 * rejects it at startup — instead of the excess-property check.
 */
const undeclaredEcho = {
  runEcho: { echo: (value: string) => OkAsync(value), undeclared: () => OkAsync(undefined) },
};
export const undeclared = EchoActivities({ value: undeclaredEcho });

/**
 * The activities built from a service they close over, recording what they saw.
 * `seen` reads the ambient record from inside the attempt — `undefined` outside
 * a unit, so its length is the unit count.
 */
const contractSeamOf = () => {
  const seen: (UnitRecord | undefined)[] = [];
  let greeting = "";

  return {
    activities: EchoActivities(
      { greeting: Greeting },
      {
        sync: ({ greeting: service }) => ({
          runEcho: {
            echo: (value) => {
              seen.push(currentUnit());
              greeting = service.text;
              return OkAsync(value);
            },
          },
        }),
      },
    ),
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
      value: {
        runEcho: {
          echo: (value) => {
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
      },
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
      value: {
        runEcho: {
          echo: (value) => {
            entered();
            return fromSafePromise(held.then(() => value));
          },
        },
      },
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
    tap: Provider(BoundConfig)(
      { config: TemporalConfig },
      {
        sync: ({ config }) => {
          bound = config;
          return config;
        },
      },
    ),
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
      idempotency: "allow-duplicate",
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
      idempotency: "allow-duplicate",
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
  const echo = TemporalWorkflowActivities(slicedContract, "runEcho")(
    { greeting: Greeting },
    {
      sync: ({ greeting: service }) => ({
        echo: (value) => {
          greeting = service.text;
          return OkAsync(value);
        },
      }),
    },
  );
  const shout = TemporalWorkflowActivities(
    slicedContract,
    "runShout",
  )({
    value: { shout: (value) => OkAsync(value.toUpperCase()) },
  });
  return {
    activities: TemporalActivities(slicedContract)([echo, shout]),
    pieces: [echo, shout] as const,
    greeting: (): string => greeting,
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
  readonly env?: Environment;
  readonly workflows?: WorkflowSource;
  readonly drainTimeoutMs?: number;
  readonly tap?: ReturnType<typeof configuredOf>["tap"];
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
};

/**
 * One booted application, composed the way a composition root composes it and
 * started against this file's own namespace — so every test opens and closes a
 * connection of its own.
 */
const compose = (server: Server, boot: Boot, options: BootOptions) => {
  const taskQueue = nextTaskQueue();
  const worker = TemporalModule("Worker")({
    contract: { ...echoContract, taskQueue },
    activities: options.activities ?? echoing,
    workflows: options.workflows ?? echoWorkflows,
    ...(options.address === undefined ? {} : { address: options.address }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    provides: [
      Provider(Greeting)({ value: { text: "hello" } }),
      ...(options.tap === undefined ? [] : [options.tap]),
    ],
  });
  const app: App = boot(worker, {
    env: options.env ?? { TEMPORAL_ADDRESS: server.address, TEMPORAL_NAMESPACE: server.namespace },
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
  });
  return { app, taskQueue };
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
          provides: [...slices.pieces, Provider(Greeting)({ value: { text: "hello" } })],
        }),
        { env: { TEMPORAL_ADDRESS: server.address, TEMPORAL_NAMESPACE: server.namespace } },
      );
      await app.runtimeInfo();
      return { app, client, taskQueue };
    });
  },
});
