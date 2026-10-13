import { mintPiece, type AnyUnitModule, type UnitGate, type UnitRecordOf } from "@btravstack/core";
import {
  Port,
  type Provider,
  type AnyPort,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";
import type { EmptyContext } from "@temporal-contract/worker/activity";

import type { ActivitiesOf, UnitNeedsOf } from "./temporal-runtime.js";
import { withFork, withUnit } from "./unit.js";

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

/**
 * What a minted piece returns. A piece naming its own `fork` owes that
 * module's unmet needs, and leaves nothing for the root's `unit.activity` to
 * export — its declared ports were checked against its own module at the call.
 */
type MintedActivities<
  C extends ContractDefinition,
  K extends ActivitiesKeyOf<C>,
  N,
  U extends Readonly<Record<string, AnyPort>>,
  M extends AnyUnitModule | undefined,
> = Provider<InstanceType<WorkflowActivitiesPortOf<C, K>>, never, N | UnitNeedsOf<M>> & {
  readonly port: WorkflowActivitiesPortOf<C, K>;
  /** Phantom: the ports this piece injects, which the root's `unit.activity` must export. */
  readonly _declared?: undefined extends M ? InstanceType<U[keyof U]> : never;
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
 *
 * `fork` names the unit module THESE activities fork per attempt instead of
 * the root's `unit.activity` — seeded with the validated input on
 * `ActivityInput(contract)` the same way — for a worker whose activities do
 * not all carry the same scope: a listing activity with no tenant in its
 * input beside a fan-out whose activities each act for one. The ports `unit`
 * declares are then checked against this module, here.
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
    const D extends Readonly<Record<string, AnyPort>> = Record<never, never>,
    const U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
    M extends AnyUnitModule | undefined = undefined,
  >(
    options: {
      readonly inject?: D;
      /** The unit-scoped ports these activities read off `context.unit`. */
      readonly unit?: U;
      /** The unit module these activities fork per attempt, in place of the root's `unit.activity`. */
      readonly fork?: M;
      readonly sync: (services: {
        readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
      }) => ScopedActivitiesOf<C, K, U>;
    } & ([keyof D] extends [never] ? unknown : { readonly inject: D }) &
      ([Exclude<M, undefined>] extends [never]
        ? unknown
        : UnitGate<Exclude<M, undefined>, InstanceType<U[keyof U]>>),
  ): MintedActivities<C, K, InstanceType<D[keyof D]>, U, M> =>
    mintPiece(port, (record, entry) => withFork(withUnit(record, entry), options.fork))(
      options as never,
    ) as never;
};
