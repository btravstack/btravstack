import type { PrincipalKey, Requirements } from "@btravstack/contract";
import { Port, Provider, type AnyPort, type PortClassOf, type ServiceOf } from "@btravstack/di";
import type { ProcedureContract, RouterContract } from "@orpc/contract";

import type { Effective, Implementation, Inherit } from "./orpc.js";

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
              [K in Exclude<keyof C, PrincipalKey> & string]: ControllerKeyOf<
                C[K],
                P extends "" ? K : `${P}.${K}`
              >;
            }[Exclude<keyof C, PrincipalKey> & string];

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
export const CONTROLLER_PREFIX = "HttpController:";

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
 * cases its procedures call; `HttpRouter(contract)([...])` composes them.
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
  <const C extends Record<string, RouterContract>, const K extends ControllerKeyOf<C>>(
    contract: C,
    key: K,
  ) => {
    // Named rather than `_`-prefixed so it reads as `contract` in the published
    // `.d.ts`; nothing needs its value.
    void contract;
    // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
    const port = class extends Port(`${CONTROLLER_PREFIX}${key}`)<
      Implementation<FragmentAt<C, K>, Schemes>
    > {};

    // Two arms discriminated by ARITY, mirroring `Provider(port)`'s own: a
    // controller that calls no use case is the common shape here.
    function build<const D extends Readonly<Record<string, AnyPort>>>(
      deps: D,
      options: {
        readonly sync: (services: {
          readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
        }) => Implementation<FragmentAt<C, K>, Schemes>;
      },
    ): Minted<C, K, Schemes, InstanceType<D[keyof D]>>;
    function build(options: {
      readonly sync: () => Implementation<FragmentAt<C, K>, Schemes>;
    }): Minted<C, K, Schemes, never>;
    function build(depsOrOptions: unknown, options?: unknown): unknown {
      return options === undefined
        ? Provider(port as never)(depsOrOptions as never)
        : Provider(port as never)(depsOrOptions as never, options as never);
    }
    return build;
  };
