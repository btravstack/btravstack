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

import type { TenantOf } from "./activity-units.js";
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
import {
  WORKFLOW_ACTIVITIES_PREFIX,
  type ActivitiesKeyOf,
  type WorkflowActivitiesPortOf,
} from "./workflow-activities.js";

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
  /** See `TemporalOptions.tenantOf`. */
  readonly tenantOf?: TenantOf;
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
    const {
      contract,
      activities,
      workflows,
      address,
      namespace,
      gracePeriod,
      forceAfter,
      tenantOf,
    } = options;
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
      ...(tenantOf === undefined ? {} : { tenantOf }),
    });
    // di's own `Module(name)({...})` over the augmented tuples: its return
    // type IS the sugar's — nothing spelled twice.
    return Module(name)({
      imports: [...imports, starter] as Imports<I, C>,
      provides: [activities, ...provides] as Provides<P, C, ActivitiesError, ActivitiesNeeds>,
      exports: [TemporalRuntime, ...exports] as readonly [typeof TemporalRuntime, ...X],
    });
  };

/** One piece of the activities record — what `TemporalWorkflowActivities(contract, key)(…)` returns. */
type PieceOf<C extends ContractDefinition> = {
  readonly [K in ActivitiesKeyOf<C>]: { readonly port: WorkflowActivitiesPortOf<C, K> };
}[ActivitiesKeyOf<C>];

/** The key a piece carries, read back off its port id. */
type KeyOfPiece<P> = P extends {
  readonly port: { readonly portId: `${typeof WORKFLOW_ACTIVITIES_PREFIX}${infer K}` };
}
  ? K
  : never;

/** The record's top-level keys no piece in `T` covers. */
type Uncovered<C extends ContractDefinition, T extends readonly PieceOf<C>[]> = Exclude<
  ActivitiesKeyOf<C>,
  KeyOfPiece<T[number]>
>;

/**
 * The composing arm. Declared LAST in the intersection below on purpose:
 * TypeScript reports the last overload's failure, so a non-covering array is
 * refused against the `"UNCOVERED ACTIVITIES"` marker rather than degrading
 * to di's `Qualification`, which names nothing. The missing key itself is
 * named in the diagnostic only when the array's length matches the marker
 * tuple's own length (2) — measured.
 */
type Compose<C extends ContractDefinition> = <const T extends readonly PieceOf<C>[]>(
  pieces: [Uncovered<C, T>] extends [never]
    ? T
    : readonly ["UNCOVERED ACTIVITIES", Uncovered<C, T>],
) => Provider<ActivitiesInstanceOf<C>, never, InstanceType<T[number]["port"]>> & {
  readonly port: ActivitiesPortOf<C>;
};

/**
 * The activities as a provider, from the contract. Three call forms, one port.
 *
 * ```ts
 * TemporalActivities(orderContract)([PlaceOrder], { sync: (place) => ({ fulfillOrder: { … } }) })
 * TemporalActivities(orderContract)([fulfillOrder, chargeOrder])
 * ```
 *
 * The first two are di's own `Provider(port)` on the starter's activities port
 * typed for the contract — any arm, same typing. The third takes the **pieces**
 * `TemporalWorkflowActivities(contract, key)` builds, one per top-level key of
 * the record: di constructs every piece first (they are the provider's deps, in
 * array order) and this reassembles the record from them. Every key must be
 * covered, and two slices claiming one key are two providers for one port — di's
 * duplicate-provider defect at build, which is the point.
 */
export const TemporalActivities = <C extends ContractDefinition>(
  contract: C,
): ReturnType<typeof Provider<ActivitiesPortOf<C>>> & Compose<C> => {
  void contract;
  const build = Provider(TemporalActivitiesPort as ActivitiesPortOf<C>);
  const compose = (pieces: readonly { readonly port: { readonly portId: string } }[]): unknown => {
    const keys = pieces.map((piece) => piece.port.portId.slice(WORKFLOW_ACTIVITIES_PREFIX.length));
    return build(
      pieces.map((piece) => piece.port) as never,
      {
        sync: (...services: readonly unknown[]) =>
          Object.fromEntries(keys.map((key, index) => [key, services[index]])),
      } as never,
    );
  };
  // One array argument is never a valid `Provider(port)` call — its arms are
  // `(deps, options)` and `(options)` — so the arity plus `Array.isArray` is a
  // sound discriminator. Not the same dispatch di's own `Provider(port)`
  // build uses, though: that one narrows on `Array.isArray` alone (`provider.ts`),
  // which is enough for ITS two arms since a lone array is never valid there;
  // the arity check here is what this THIRD, composing arm needs on top of it.
  return ((first: unknown, second?: unknown) =>
    second === undefined && Array.isArray(first)
      ? compose(first as readonly { readonly port: { readonly portId: string } }[])
      : (build as (a: never, b?: never) => unknown)(first as never, second as never)) as never;
};
