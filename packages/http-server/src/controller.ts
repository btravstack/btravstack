import type { PrincipalKey, Requirements } from "@btravstack/contract";
import { Port, Provider, type AnyPort, type PortClassOf, type ServiceOf } from "@btravstack/di";
import type { ProcedureContract, RouterContract } from "@orpc/contract";

import type { Effective, Implementation, Inherit } from "./orpc.js";

/**
 * The keys of one contract node a piece path can name: its own, less any
 * carrying a literal dot. A path is joined and split on `.`, so a dotted key is
 * indistinguishable from the nesting it would encode — see `Unsliceable` in
 * `orpc.ts` for the other half of the refusal.
 */
type Nameable<C> = Exclude<Exclude<keyof C, PrincipalKey> & string, `${string}.${string}`>;

/** Every path into the contract tree — a fragment or a procedure, at any depth. */
export type ControllerKeyOf<C, P extends string = ""> =
  C extends ProcedureContract<infer _I, infer _O, infer _E>
    ? P
    : // An index-signature record is only ever a GENERIC's constraint
      // (`RouterContract` is recursive), never a concrete contract; recursing
      // over `string` keys is TS2589, measured at every generic declaration
      // whose constraint mentions this type.
      string extends keyof C
      ? string
      :
          | (P extends "" ? never : P)
          | {
              [K in Nameable<C>]: ControllerKeyOf<C[K], P extends "" ? K : `${P}.${K}`>;
            }[Nameable<C>];

/**
 * Every path into the tree, dotted keys INCLUDED — what `ControllerKeyOf` would
 * be without the refusal. The `key` parameter is constrained by this rather than
 * by `ControllerKeyOf` so that an unsliceable path still binds `K`, and
 * `SliceableGate` can then refuse it with a sentence naming it. Constraining by
 * `ControllerKeyOf` directly refuses it too, but only as
 * `not assignable to parameter of type '"plain"'` — a typo hint, which is the
 * wrong thing to send a reader hunting for.
 */
type AnyKeyOf<C, P extends string = ""> =
  C extends ProcedureContract<infer _I, infer _O, infer _E>
    ? P
    : string extends keyof C
      ? string
      :
          | (P extends "" ? never : P)
          | {
              [K in Exclude<keyof C, PrincipalKey> & string]: AnyKeyOf<
                C[K],
                P extends "" ? K : `${P}.${K}`
              >;
            }[Exclude<keyof C, PrincipalKey> & string];

/**
 * Intersected onto `key`, the way `ScopeGate` rides `contract`: `unknown` for a
 * nameable path, and otherwise a sentence carrying the offending path, so the
 * diagnostic says what is wrong rather than which keys were expected.
 */
type SliceableGate<C, K> =
  K extends ControllerKeyOf<C>
    ? unknown
    : {
        readonly "UNSLICEABLE CONTRACT KEY — this path names a key containing a literal dot, which a piece path cannot encode; serve this contract with the (deps, arm) form instead": K;
      };

/**
 * What a piece minted at `P` implements: the node the path names, carrying the
 * requirements every mark ABOVE it establishes. The fold mirrors `routerOf`'s
 * `inherited` argument step for step — nearest mark wins at each level — so the
 * types and the runtime walk cannot part.
 */
type FragmentAt<
  C,
  P extends string,
  R extends Requirements = never,
> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof C
    ? FragmentAt<C[Head], Rest, Effective<C, R>>
    : never
  : P extends keyof C
    ? Inherit<C[P], Effective<C, R>>
    : never;

/**
 * The port one piece targets. Its id carries the contract path, which is what
 * makes two slices claiming one fragment di's duplicate-provider defect rather
 * than a silent merge, and what lets the composing form recover each piece's
 * path by stripping the prefix rather than needing it spelled again.
 */
export type ControllerPortOf<
  C extends Record<string, RouterContract>,
  K extends ControllerKeyOf<C>,
  Schemes = never,
> = PortClassOf<`${typeof CONTROLLER_PREFIX}${K}`, Implementation<FragmentAt<C, K>, Schemes>>;

/** The prefix a piece's port id carries; the composing form strips it to recover the path. */
export const CONTROLLER_PREFIX = "OrpcController:";

/** What both arms of a minted controller return; `N` is the only thing that differs. */
type Minted<
  C extends Record<string, RouterContract>,
  K extends ControllerKeyOf<C>,
  Schemes,
  N,
> = Provider<InstanceType<ControllerPortOf<C, K, Schemes>>, never, N> & {
  readonly port: ControllerPortOf<C, K, Schemes>;
};

/**
 * One node of a contract, at any depth, as a provider on a port of its own.
 *
 * A large API is several pieces, each owning one node of the contract tree —
 * named by a dotted path, `"orders"` or `"v1.orders"` — and declaring the use
 * cases its procedures call; `OrpcRouter(contract)([...])` composes them.
 * `contract` is read for its TYPE only, and types both `key` and the
 * handlers — so a path the contract does not declare, or a procedure the
 * fragment does not, is a compile error here rather than at the root.
 *
 * There is no name to give: the path IS the port's name, minted as
 * `` `${CONTROLLER_PREFIX}${key}` `` — the move `AmqpHandler(contract, key)`
 * makes. `FragmentAt` carries every ancestor mark down to the piece, so a
 * marked ancestor types `context.principal` where the handler is written.
 */
export const controllerFor =
  <Schemes>() =>
  <
    const C extends Record<string, RouterContract>,
    const K extends AnyKeyOf<C>,
    // Never supplied: `K` is constrained widely so an unsliceable path can bind
    // and be named in the diagnostic, and `Key` is that path narrowed back to
    // the half a port may carry. A caller that passes the gate has `Key = K`.
    Key extends ControllerKeyOf<C> = Extract<K, ControllerKeyOf<C>>,
  >(
    contract: C,
    key: K & SliceableGate<C, K>,
  ) => {
    // Named rather than `_`-prefixed so it reads as `contract` in the published
    // `.d.ts`; nothing needs its value.
    void contract;
    // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
    const port = class extends Port(`${CONTROLLER_PREFIX}${key as K}`)<
      Implementation<FragmentAt<C, Key>, Schemes>
    > {};

    // Two arms discriminated by ARITY, mirroring `Provider(port)`'s own: a
    // controller that calls no use case is the common shape here.
    function build<const D extends Readonly<Record<string, AnyPort>>>(
      deps: D,
      options: {
        readonly sync: (services: {
          readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
        }) => Implementation<FragmentAt<C, Key>, Schemes>;
      },
    ): Minted<C, Key, Schemes, InstanceType<D[keyof D]>>;
    function build(options: {
      readonly sync: () => Implementation<FragmentAt<C, Key>, Schemes>;
    }): Minted<C, Key, Schemes, never>;
    function build(depsOrOptions: unknown, options?: unknown): unknown {
      return options === undefined
        ? Provider(port as never)(depsOrOptions as never)
        : Provider(port as never)(depsOrOptions as never, options as never);
    }
    return build;
  };
