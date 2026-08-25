import { Port, Provider, type PortClassOf } from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";

import type { ActivitiesOf } from "./temporal-runtime.js";

/**
 * `ActivitiesOf<C>` is a `NoInfer`-wrapped intersection of a conditional and a
 * mapped type, which TypeScript refuses to index by a generic key directly
 * ("Type 'K' cannot be used to index type ..."). Routing it through `infer`
 * forces the checker to resolve it to a plain object type first, which IS
 * indexable — the standard workaround for indexing a generic conditional type.
 */
type ActivitiesRecordOf<C extends ContractDefinition> =
  ActivitiesOf<C> extends infer Resolved ? Resolved : never;

/** The top-level keys of `C`'s activities record: a workflow that declares activities, or a contract-global activity. */
export type ActivitiesKeyOf<C extends ContractDefinition> = keyof ActivitiesRecordOf<C> & string;

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
 * One workflow's activities, as a provider on a port of its own.
 *
 * A worker that polls one queue for several workflows is several pieces, each
 * declaring the services its own activities call;
 * `TemporalActivities(contract)([...])` composes them. `contract` is read for
 * its **type** only — it is what types `key` and the record, so an activity
 * the workflow does not declare, or one whose input has drifted, is a compile
 * error here rather than at startup.
 *
 * `key` is any top-level key of the activities record, which includes a
 * **contract-global** activity as well as a workflow. The name is imprecise in
 * that one case, deliberately: narrowing to workflow keys would cost extra
 * type code and lock a contract with global activities out of the split.
 *
 * There is no name to give: the key IS the port's name. The return is di's own
 * `Provider(port)`, so every arm is available exactly as on
 * `TemporalActivities(contract)`.
 */
export const TemporalWorkflowActivities = <
  C extends ContractDefinition,
  const K extends ActivitiesKeyOf<C>,
>(
  contract: C,
  key: K,
): ReturnType<typeof Provider<WorkflowActivitiesPortOf<C, K>>> => {
  // The parameter is named, not `_`-prefixed, so it reads as `contract` in the
  // published `.d.ts` and in an editor hint; nothing needs its value.
  void contract;
  // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
  const port = class extends Port(`${WORKFLOW_ACTIVITIES_PREFIX}${key}`)<
    ActivitiesRecordOf<C>[K]
  > {};
  return Provider(port as never) as never;
};
