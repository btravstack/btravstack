import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  type AnyModule,
  type AnyProvider,
  type Available,
  type ErrOf,
  type ErrOfModule,
  type Exportable,
  type NeedOf,
  type NeedsOfModule,
  type Provider,
  type ResolvedExports,
  type Scope,
  type ServiceOf,
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

/**
 * `unknown` when the provider's port carries the implementations record
 * `declareActivitiesHandler` takes for `C`, `never` otherwise — intersected
 * with the provider at the call site, so a provider of anything else fails to
 * typecheck there.
 */
type ActivitiesProvider<ActivitiesInstance, C extends ContractDefinition> =
  ServiceOf<ActivitiesInstance> extends ActivitiesOf<C> ? unknown : never;

export type TemporalModuleOptions<
  C extends ContractDefinition,
  ActivitiesInstance,
  ActivitiesError,
  ActivitiesNeeds,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<
    [...I, TemporalStarter<ActivitiesInstance>],
    [Provider<ActivitiesInstance, ActivitiesError, ActivitiesNeeds>, ...P]
  >[],
> = {
  /** The `temporal-contract` contract; the task queue this worker polls is read off it. */
  readonly contract: C;
  /** The application's activity implementations, as the provider that builds the record from the services they close over. */
  readonly activities: Provider<ActivitiesInstance, ActivitiesError, ActivitiesNeeds> &
    ActivitiesProvider<ActivitiesInstance, C>;
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
    ActivitiesInstance,
    ActivitiesError,
    ActivitiesNeeds,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<
      [...I, TemporalStarter<ActivitiesInstance>],
      [Provider<ActivitiesInstance, ActivitiesError, ActivitiesNeeds>, ...P]
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
  ): Module<
    ResolvedExports<[typeof TemporalRuntime, ...X]>,
    | ErrOf<[Provider<ActivitiesInstance, ActivitiesError, ActivitiesNeeds>, ...P][number]>
    | ErrOfModule<[...I, TemporalStarter<ActivitiesInstance>][number]>,
    Exclude<
      | NeedOf<[Provider<ActivitiesInstance, ActivitiesError, ActivitiesNeeds>, ...P][number]>
      | NeedsOfModule<[...I, TemporalStarter<ActivitiesInstance>][number]>,
      Available<
        [...I, TemporalStarter<ActivitiesInstance>],
        [Provider<ActivitiesInstance, ActivitiesError, ActivitiesNeeds>, ...P]
      >
    >
  > => {
    const {
      contract,
      activities,
      workflows,
      address,
      namespace,
      gracePeriod,
      forceAfter,
      imports = [],
      provides = [],
      exports = [],
    } = options;
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
    // The typing above is the whole contract; the value is the plain module
    // it describes. `never` because di computes the declared type from the
    // literal it is handed, and generic `I`/`P`/`X` are not one.
    return Module(name)({
      imports: [...imports, starter],
      provides: [activities, ...provides],
      exports: [TemporalRuntime, ...exports],
    } as never) as never;
  };
