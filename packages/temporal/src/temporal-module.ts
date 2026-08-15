import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  Port,
  Provider,
  type AnyModule,
  type AnyProvider,
  type Exportable,
  type PortClassOf,
  type PortInstance,
  type Scope,
} from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";
import type { Duration } from "@temporalio/common";

import {
  TemporalRuntime,
  temporal,
  type ActivitiesOf,
  type TemporalConfig,
  type TemporalConnection,
  type TemporalUnreachable,
  type WorkflowSource,
} from "./temporal-runtime.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type TemporalStarter<ActivitiesInstance> = Module<
  TemporalRuntime | TemporalConfig | TemporalConnection,
  ConfigInvalid | TemporalUnreachable,
  Env | Scope | ActivitiesInstance
>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[], ActivitiesInstance> = readonly [
  ...I,
  TemporalStarter<ActivitiesInstance>,
];

/** The activities provider plus the application's own — the tuple `Module(name)` is handed. */
type Provides<
  P extends readonly AnyProvider[],
  ActivitiesInstance,
  ActivitiesError,
  ActivitiesNeeds,
> = readonly [Provider<ActivitiesInstance, ActivitiesError, ActivitiesNeeds>, ...P];

export type TemporalModuleOptions<
  C extends ContractDefinition,
  ActivitiesInstance extends PortInstance<string, ActivitiesOf<C>>,
  ActivitiesError,
  ActivitiesNeeds,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<
    Imports<I, ActivitiesInstance>,
    Provides<P, ActivitiesInstance, ActivitiesError, ActivitiesNeeds>
  >[],
> = {
  /** The `temporal-contract` contract; the task queue this worker polls is read off it. */
  readonly contract: C;
  /** The application's activity implementations, as the provider that builds the record from the services they close over. */
  readonly activities: Provider<ActivitiesInstance, ActivitiesError, ActivitiesNeeds>;
  readonly workflows: WorkflowSource;
  /** Pins `TemporalConfig.address` instead of reading `TEMPORAL_ADDRESS`. */
  readonly address?: string;
  /** Pins `TemporalConfig.namespace` instead of reading `TEMPORAL_NAMESPACE`. */
  readonly namespace?: string;
  /** Temporal's `shutdownGraceTime`. Default `10 seconds`. */
  readonly gracePeriod?: Duration;
  /** Temporal's `shutdownForceTime`. Default `15 seconds`. Keep it at or below the kernel's `drainTimeoutMs`. */
  readonly forceAfter?: Duration;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `TemporalRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
};

/**
 * `Module(name)({...})` for a Temporal worker deployment: everything a di
 * module takes, plus the contract, the activities provider and the workflow
 * source, and nothing else to know. The sugar imports the starter
 * (`temporal({ contract, activities, workflows })`), provides the activities,
 * and exports `TemporalRuntime` — so a root that would otherwise write those
 * lines and remember that `start` needs the runtime exported writes none of
 * them. It hands back exactly the module `Module(...)` would have declared
 * over the augmented `imports`/`provides`/`exports` (spelled from di's own
 * pieces), so the kernel, `start`'s gate and di's see nothing new: syntax over
 * the same primitives, one source of truth.
 *
 * ```ts
 * export const OrderTemporalWorker = TemporalModule("OrderTemporalWorker")({
 *   contract: orderContract,
 *   activities: orderActivities,
 *   workflows: { workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js") },
 *   imports: [ApplicationModule, PersistenceModule, FulfillmentModule],
 * });
 * await runMain(OrderTemporalWorker);
 * ```
 */
export const TemporalModule =
  <const Name extends string>(name: Name) =>
  <
    C extends ContractDefinition,
    ActivitiesInstance extends PortInstance<string, ActivitiesOf<C>>,
    ActivitiesError,
    ActivitiesNeeds,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<
      Imports<I, ActivitiesInstance>,
      Provides<P, ActivitiesInstance, ActivitiesError, ActivitiesNeeds>
    >[] = [],
  >(
    options: TemporalModuleOptions<
      C,
      ActivitiesInstance,
      ActivitiesError,
      ActivitiesNeeds,
      I,
      P,
      X
    >,
  ) => {
    const { contract, activities, workflows, address, namespace, gracePeriod, forceAfter } =
      options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    // `activities.port` is the port class the provider targets — `AnyPort` at
    // this level; the constraint that its service is the implementations record
    // was checked on the provider's instance type above, so `temporal()`'s
    // class-level check has nothing left to add.
    const starter = temporal({
      contract,
      activities: activities.port as never,
      workflows,
      ...(address === undefined ? {} : { address }),
      ...(namespace === undefined ? {} : { namespace }),
      ...(gracePeriod === undefined ? {} : { gracePeriod }),
      ...(forceAfter === undefined ? {} : { forceAfter }),
    });
    // di's own `Module(name)({...})` over the augmented tuples: its return
    // type IS the sugar's — nothing spelled twice.
    return Module(name)({
      imports: [...imports, starter as TemporalStarter<ActivitiesInstance>] as Imports<
        I,
        ActivitiesInstance
      >,
      provides: [activities, ...provides] as Provides<
        P,
        ActivitiesInstance,
        ActivitiesError,
        ActivitiesNeeds
      >,
      exports: [TemporalRuntime, ...exports] as readonly [typeof TemporalRuntime, ...X],
    });
  };

/**
 * The activities' port and provider in one call:
 * `TemporalActivities(orderContract)("OrderActivities")([PlaceOrder, StockService],
 * { sync: (place, stock) => ({ fulfillOrder: { … } }) })`. The first call
 * fixes the contract, the second mints a port named `name` whose service is
 * the implementations record `declareActivitiesHandler` takes for it — the
 * one shape `TemporalModule` accepts — and returns di's own `Provider(port)`,
 * so the third call is exactly what it is everywhere else: any arm, same
 * typing, and the provider it hands back carries the port typed
 * (`orderActivities.port`) for whoever names it. The class line and its
 * `DeclareActivitiesHandlerOptions<C>["activities"]` are what disappear.
 */
export const TemporalActivities =
  <C extends ContractDefinition>(_contract: C) =>
  <const Name extends string>(
    name: Name,
  ): ReturnType<typeof Provider<PortClassOf<Name, ActivitiesOf<C>>>> =>
    Provider(class extends Port(name)<ActivitiesOf<C>> {} as PortClassOf<Name, ActivitiesOf<C>>);
