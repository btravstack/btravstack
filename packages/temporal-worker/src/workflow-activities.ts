import { Port, Provider, type PortClassOf } from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";

import type { ActivitiesOf } from "./temporal-runtime.js";

/**
 * `ActivitiesOf<C>` is a `NoInfer`-wrapped conditional TypeScript refuses to
 * index by a generic key. Routing it through `infer` resolves it to a plain
 * object type first, which IS indexable.
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
 * its TYPE only, and types both `key` and the record — so an activity the
 * workflow does not declare is a compile error here rather than at startup.
 *
 * `key` is any top-level key of the activities record, which includes a
 * contract-global activity as well as a workflow; the name is imprecise in that
 * one case deliberately, since narrowing it would lock such a contract out of
 * the split.
 *
 * There is no name to give: the key IS the port's name.
 */
export const TemporalWorkflowActivities = <
  C extends ContractDefinition,
  const K extends ActivitiesKeyOf<C>,
>(
  contract: C,
  key: K,
): ReturnType<typeof Provider<WorkflowActivitiesPortOf<C, K>>> => {
  // Named rather than `_`-prefixed so it reads as `contract` in the published
  // `.d.ts`; nothing needs its value.
  void contract;
  // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
  const port = class extends Port(`${WORKFLOW_ACTIVITIES_PREFIX}${key}`)<
    ActivitiesRecordOf<C>[K]
  > {};
  return Provider(port as never) as never;
};
