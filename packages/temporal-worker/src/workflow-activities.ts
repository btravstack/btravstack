import {
  Port,
  Provider,
  type AnyPort,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";
import type { EmptyContext } from "@temporal-contract/worker/activity";

import type { ActivitiesOf } from "./temporal-runtime.js";
import { withUnit, type UnitRecordOf } from "./unit.js";

/**
 * `ActivitiesOf<C, …>` is a `NoInfer`-wrapped conditional TypeScript refuses to
 * index by a generic key. Routing it through `infer` resolves it to a plain
 * object type first, which IS indexable.
 */
type ActivitiesRecordOf<
  C extends ContractDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> = ActivitiesOf<C, TContext> extends infer Resolved ? Resolved : never;

/** The top-level keys of `C`'s activities record: a workflow that declares activities, or a contract-global activity. */
export type ActivitiesKeyOf<C extends ContractDefinition> = keyof ActivitiesRecordOf<C> & string;

/**
 * One entry's validated input, reached through the implementation's own second
 * parameter — a workflow key carries a record of implementations, a
 * contract-global one carries the implementation itself. `WorkerInferInput` is
 * declared by `@temporal-contract/worker` and exported from none of its
 * subpaths, so the by-index route is the only one open.
 */
type InputOfEntry<V> = V extends (helpers: never, input: infer I) => unknown
  ? I
  : V extends Readonly<Record<string, unknown>>
    ? InputOfEntry<V[keyof V]>
    : never;

/** The validated activity input, typed by the contract: the union of every activity's own input. */
export type ActivityInputOf<C extends ContractDefinition> = InputOfEntry<
  ActivitiesRecordOf<C>[ActivitiesKeyOf<C>]
>;

/** The seeded port's class, typed for `C`: what `ActivityInput(contract)` answers. */
export type ActivityInputPortOf<C extends ContractDefinition> = PortClassOf<
  "ActivityInput",
  ActivityInputOf<C>
>;

/**
 * The seed's port instance, as it appears in a needs union — subtracted from
 * what a bound `unit.activity` module still owes, since the fork is what
 * discharges it.
 */
export type ActivityInputInstance = PortInstance<"ActivityInput", unknown>;

/** One id, declared once, so no contract instantiating it warns about a duplicate. */
export const ActivityInputPort = Port("ActivityInput");

/**
 * The validated activity input as a port: the one thing the worker seeds the
 * fork with, so a `unit.activity` module derives a tenant — or anything else —
 * from the invocation rather than from an ambient record.
 *
 * ```ts
 * const Input = ActivityInput(orderContract);
 * const ActivityUnit = Module("ActivityUnit")({
 *   needs: [Input],
 *   provides: [Provider(Tenant)({ inject: { input: Input }, sync: ({ input }) => input.tenantId })],
 *   exports: [Tenant],
 * });
 * ```
 *
 * `contract` is read for its TYPE only. One `Port(...)` call fixed per contract
 * at the type level, the move `TemporalActivitiesPort` makes, so a module built
 * for one contract cannot read another's input.
 */
export const ActivityInput = <C extends ContractDefinition>(
  contract: C,
): ActivityInputPortOf<C> => {
  void contract;
  return ActivityInputPort as ActivityInputPortOf<C>;
};

/** The prefix a piece's port id carries; the composing form strips it to recover the key. */
export const WORKFLOW_ACTIVITIES_PREFIX = "TemporalWorkflowActivities:";

/**
 * The port one piece targets. Its id carries the key, which is what makes two
 * slices claiming one workflow di's duplicate-provider defect rather than a
 * silent merge.
 */
export type WorkflowActivitiesPortOf<
  C extends ContractDefinition,
  K extends ActivitiesKeyOf<C>,
> = PortClassOf<`${typeof WORKFLOW_ACTIVITIES_PREFIX}${K}`, ActivitiesRecordOf<C>[K]>;

/** What a minted piece returns. */
type MintedActivities<
  C extends ContractDefinition,
  K extends ActivitiesKeyOf<C>,
  N,
  U extends Readonly<Record<string, AnyPort>>,
> = Provider<InstanceType<WorkflowActivitiesPortOf<C, K>>, never, N> & {
  readonly port: WorkflowActivitiesPortOf<C, K>;
  /** The declared `unit:` record, which the wrapper resolves against. */
  readonly unit: U;
  /** Phantom: the ports this piece injects, which the root's `unit.activity` must export. */
  readonly _declared?: InstanceType<U[keyof U]>;
};

/** The activities `sync` hands back, typed by the record THIS piece declared. */
type ScopedActivitiesOf<
  C extends ContractDefinition,
  K extends ActivitiesKeyOf<C>,
  U extends Readonly<Record<string, AnyPort>>,
> = ActivitiesRecordOf<C, { readonly unit: UnitRecordOf<U> }>[K &
  keyof ActivitiesRecordOf<C, { readonly unit: UnitRecordOf<U> }>];

/**
 * One workflow's activities, as a provider on a port of its own.
 *
 * A worker that polls one queue for several workflows is several pieces, each
 * declaring the services its own activities call;
 * `TemporalActivities(contract)([...])` composes them. `contract` is read for
 * its TYPE only, and types both `key` and the record — so an activity the
 * workflow does not declare is a compile error here rather than at startup.
 *
 * `key` is any top-level key of the activities record, which includes a
 * contract-global activity as well as a workflow; the name is imprecise in that
 * one case deliberately, since narrowing it would lock such a contract out of
 * the split.
 *
 * There is no name to give: the key IS the port's name.
 *
 * `unit` declares the ports the activities read off `context.unit`, resolved
 * out of the fork the attempt opened; the root's `unit.activity` module must
 * export every one of them.
 */
export const TemporalWorkflowActivities = <
  C extends ContractDefinition,
  const K extends ActivitiesKeyOf<C>,
>(
  contract: C,
  key: K,
) => {
  // Named rather than `_`-prefixed so it reads as `contract` in the published
  // `.d.ts`; nothing needs its value.
  void contract;
  // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
  const port = class extends Port(`${WORKFLOW_ACTIVITIES_PREFIX}${key}`)<
    ActivitiesRecordOf<C>[K]
  > {};

  return <
    const D extends Readonly<Record<string, AnyPort>>,
    const U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
  >(options: {
    readonly inject: D;
    /** The unit-scoped ports these activities read off `context.unit`. */
    readonly unit?: U;
    readonly sync: (services: {
      readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
    }) => ScopedActivitiesOf<C, K, U>;
  }): MintedActivities<C, K, InstanceType<D[keyof D]>, U> => {
    const record = options.unit ?? {};
    return Object.assign(
      Provider(port as never)({
        inject: options.inject,
        sync: (services: never) => withUnit(record, options.sync(services)),
      } as never),
      { unit: record },
    ) as never;
  };
};
