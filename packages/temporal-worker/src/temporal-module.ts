import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  Provider,
  type AnyModule,
  type AnyPort,
  type AnyProvider,
  type Exportable,
  type NeedsGate,
  type Scope,
} from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";

import {
  TemporalActivitiesPort,
  TemporalRuntime,
  temporal,
  type ActivitiesInstanceOf,
  type ActivitiesPortOf,
  type AnyUnitModule,
  type TemporalConfig,
  type TemporalConnection,
  type TemporalTuning,
  type TemporalUnreachable,
  type UnitNeedsOf,
  type WorkflowSource,
} from "./temporal-runtime.js";
import {
  WORKFLOW_ACTIVITIES_PREFIX,
  type ActivitiesKeyOf,
  type WorkflowActivitiesPortOf,
} from "./workflow-activities.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type TemporalStarter<C extends ContractDefinition, Unit extends AnyUnitModule | undefined> = Module<
  TemporalRuntime | TemporalConfig | TemporalConnection,
  ConfigInvalid | TemporalUnreachable,
  Env | Scope | ActivitiesInstanceOf<C> | UnitNeedsOf<Unit>
>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<
  I extends readonly AnyModule[],
  C extends ContractDefinition,
  Unit extends AnyUnitModule | undefined,
> = readonly [...I, TemporalStarter<C, Unit>];

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
  Unit extends AnyUnitModule | undefined,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<
    Imports<I, C, Unit>,
    Provides<P, C, ActivitiesError, ActivitiesNeeds>
  >[],
  N extends readonly AnyPort[],
> = TemporalTuning<Unit> & {
  /** The `temporal-contract` contract; the task queue this worker polls is read off it. */
  readonly contract: C;
  readonly workflows: WorkflowSource;
  /** The application's activity implementations — what `TemporalActivities(contract)(…)` returns. */
  readonly activities: Provider<ActivitiesInstanceOf<C>, ActivitiesError, ActivitiesNeeds>;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `TemporalRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
  /**
   * What this root's OWN providers expect from outside. di's gate is re-stated
   * over the augmented tuples below, so forgetting one is an error at THIS call.
   */
  readonly needs?: N;
} & NeedsGate<Imports<I, C, Unit>, Provides<P, C, ActivitiesError, ActivitiesNeeds>, N>;

/**
 * `Module(name)({...})` for a Temporal worker deployment: everything a di module
 * takes, plus the contract, the activities provider and the workflow source. The
 * sugar imports the starter, provides the activities and exports
 * `TemporalRuntime`, handing back exactly the module `Module(...)` would have
 * declared over the augmented tuples.
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
    Unit extends AnyUnitModule | undefined = undefined,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<
      Imports<I, C, Unit>,
      Provides<P, C, ActivitiesError, ActivitiesNeeds>
    >[] = [],
    const N extends readonly AnyPort[] = [],
  >(
    options: TemporalModuleOptions<C, ActivitiesError, ActivitiesNeeds, Unit, I, P, X, N>,
  ) => {
    const { activities } = options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    // The whole options record, not a field-by-field spread:
    // `TemporalModuleOptions` IS `TemporalTuning` plus the contract, the
    // workflows, the activities and the module lists, so an option this sugar
    // forgets to forward cannot exist. The lists `temporal()` does not know are
    // ignored rather than rejected.
    const starter = temporal(options);
    // The assertion is the gate, not the shape: `NeedsGate` defers while the
    // tuples are type parameters, and is computed at the application's own call
    // because the options type re-declares it. Spelled out rather than
    // `as never`, which collapses the return to `Module<never, never, never>`.
    return Module(name)({
      imports: [...imports, starter] as Imports<I, C, Unit>,
      provides: [activities, ...provides] as Provides<P, C, ActivitiesError, ActivitiesNeeds>,
      exports: [TemporalRuntime, ...exports] as readonly [typeof TemporalRuntime, ...X],
      needs: (options.needs ?? []) as N,
    } as {
      readonly imports: Imports<I, C, Unit>;
      readonly provides: Provides<P, C, ActivitiesError, ActivitiesNeeds>;
      readonly exports: readonly [typeof TemporalRuntime, ...X];
      readonly needs: N;
    } & NeedsGate<Imports<I, C, Unit>, Provides<P, C, ActivitiesError, ActivitiesNeeds>, N>);
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
 * A refused array: as long as the array the caller wrote, its head the caller's
 * own elements — which match — and its LAST element the marker paired with what
 * is wrong.
 *
 * TypeScript compares two equal-length tuples element by element, so the extra
 * diagnostic it reports lands on the trailing element and carries both the
 * sentence and the missing key. A fixed two-element tuple named the key only
 * when the array happened to be two elements long; every other arity was a
 * length mismatch, and the developer diffed the contract against the array by
 * hand.
 */
type Refuse<T extends readonly unknown[], Marker extends string, Detail> = T extends readonly [
  ...infer Head,
  unknown,
]
  ? readonly [...Head, readonly [Marker, Detail]]
  : readonly [readonly [Marker, Detail]];

/**
 * The composing arm. Declared LAST in the intersection below on purpose:
 * TypeScript reports the last overload's failure, so a non-covering array is
 * refused against the `"UNCOVERED ACTIVITIES — …"` marker rather than degrading
 * to di's `Qualification`, which names nothing.
 *
 * The marker is a sentence rather than a bare label because it prints last,
 * after the caller's own several-hundred-character piece type.
 */
type Compose<C extends ContractDefinition> = <const T extends readonly PieceOf<C>[]>(
  pieces: [Uncovered<C, T>] extends [never]
    ? T
    : Refuse<
        T,
        "UNCOVERED ACTIVITIES — the contract declares a workflow this array does not cover",
        Uncovered<C, T>
      >,
) => Provider<ActivitiesInstanceOf<C>, never, InstanceType<T[number]["port"]>> & {
  readonly port: ActivitiesPortOf<C>;
};

/**
 * The activities as a provider, from the contract. Two call forms, one port.
 *
 * ```ts
 * TemporalActivities(orderContract)({ inject: { place: PlaceOrder }, sync: ({ place }) => ({ fulfillOrder: { … } }) })
 * TemporalActivities(orderContract)([fulfillOrder, chargeOrder])
 * ```
 *
 * The first is di's own `Provider(port)` on the starter's activities port
 * typed for the contract. The second takes the pieces
 * `TemporalWorkflowActivities(contract, key)` builds: they are the provider's
 * deps, keyed by the contract key each piece's port id carries, so the services
 * record IS the activities record. Every key must be covered, and two slices
 * claiming one key are di's duplicate-provider defect at build.
 */
export const TemporalActivities = <C extends ContractDefinition>(
  contract: C,
): ReturnType<typeof Provider<ActivitiesPortOf<C>>> & Compose<C> => {
  void contract;
  const build = Provider(TemporalActivitiesPort as ActivitiesPortOf<C>);
  const compose = (pieces: readonly { readonly port: { readonly portId: string } }[]): unknown =>
    build({
      inject: Object.fromEntries(
        pieces.map((piece) => [
          piece.port.portId.slice(WORKFLOW_ACTIVITIES_PREFIX.length),
          piece.port,
        ]),
      ),
      sync: (services: unknown) => services,
    } as never);
  // An array is never a valid `Provider(port)` call — its one argument is a
  // record — so `Array.isArray` alone identifies the composing arm.
  return ((first: unknown) =>
    Array.isArray(first)
      ? compose(first as readonly { readonly port: { readonly portId: string } }[])
      : (build as (a: never) => unknown)(first as never)) as never;
};
