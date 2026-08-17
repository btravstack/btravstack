import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  Provider,
  type AnyModule,
  type AnyProvider,
  type Exportable,
  type Scope,
} from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";
import type { Duration } from "@temporalio/common";

import {
  TemporalActivitiesPort,
  TemporalRuntime,
  temporal,
  type ActivitiesInstanceOf,
  type ActivitiesPortOf,
  type TemporalConfig,
  type TemporalConnection,
  type TemporalUnreachable,
  type WorkflowSource,
} from "./temporal-runtime.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type TemporalStarter<C extends ContractDefinition> = Module<
  TemporalRuntime | TemporalConfig | TemporalConnection,
  ConfigInvalid | TemporalUnreachable,
  Env | Scope | ActivitiesInstanceOf<C>
>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[], C extends ContractDefinition> = readonly [
  ...I,
  TemporalStarter<C>,
];

/** The activities provider plus the application's own — the tuple `Module(name)` is handed. */
type Provides<
  P extends readonly AnyProvider[],
  C extends ContractDefinition,
  ActivitiesError,
  ActivitiesNeeds,
> = readonly [Provider<ActivitiesInstanceOf<C>, ActivitiesError, ActivitiesNeeds>, ...P];

export type TemporalModuleOptions<
  C extends ContractDefinition,
  ActivitiesError,
  ActivitiesNeeds,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<Imports<I, C>, Provides<P, C, ActivitiesError, ActivitiesNeeds>>[],
> = {
  /** The `temporal-contract` contract; the task queue this worker polls is read off it. */
  readonly contract: C;
  /** The application's activity implementations — `TemporalActivities(contract)(deps, arm)`, the provider that builds the record for THIS contract from the services it closes over. */
  readonly activities: Provider<ActivitiesInstanceOf<C>, ActivitiesError, ActivitiesNeeds>;
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
 * (`temporal({ contract, workflows })`), provides the activities,
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
 *   imports: [OrderApplicationModule, OrderPersistenceModule, FulfillmentModule],
 * });
 * await runMain(OrderTemporalWorker);
 * ```
 */
export const TemporalModule =
  <const Name extends string>(name: Name) =>
  <
    C extends ContractDefinition,
    ActivitiesError,
    ActivitiesNeeds,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<
      Imports<I, C>,
      Provides<P, C, ActivitiesError, ActivitiesNeeds>
    >[] = [],
  >(
    options: TemporalModuleOptions<C, ActivitiesError, ActivitiesNeeds, I, P, X>,
  ) => {
    const { contract, activities, workflows, address, namespace, gracePeriod, forceAfter } =
      options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    const starter = temporal({
      contract,
      workflows,
      ...(address === undefined ? {} : { address }),
      ...(namespace === undefined ? {} : { namespace }),
      ...(gracePeriod === undefined ? {} : { gracePeriod }),
      ...(forceAfter === undefined ? {} : { forceAfter }),
    });
    // di's own `Module(name)({...})` over the augmented tuples: its return
    // type IS the sugar's — nothing spelled twice.
    return Module(name)({
      imports: [...imports, starter] as Imports<I, C>,
      provides: [activities, ...provides] as Provides<P, C, ActivitiesError, ActivitiesNeeds>,
      exports: [TemporalRuntime, ...exports] as readonly [typeof TemporalRuntime, ...X],
    });
  };

/**
 * The activities as a provider, from the contract:
 * `TemporalActivities(orderContract)([PlaceOrder, StockService], { sync:
 * (place, stock) => ({ fulfillOrder: { … } }) })`. The first call fixes the
 * contract and returns di's own `Provider(port)` on the starter's activities
 * port typed for it — the implementations record `declareActivitiesHandler`
 * takes, the one shape `TemporalModule` accepts — so the second call is
 * exactly what it is everywhere else: any arm, same typing. There is no name
 * to give: a worker serves one activities record, so the port is the
 * starter's, and the provider carries it typed (`orderActivities.port`) for
 * whoever needs the class. The class line and its
 * `DeclareActivitiesHandlerOptions<C>["activities"]` are what disappear.
 */
export const TemporalActivities = <C extends ContractDefinition>(
  _contract: C,
): ReturnType<typeof Provider<ActivitiesPortOf<C>>> =>
  Provider(TemporalActivitiesPort as ActivitiesPortOf<C>);
