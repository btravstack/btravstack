import type { PrincipalKey, RequirementsOf } from "@btravstack/contract";
import { Port, Provider, type AnyPort, type PortClassOf, type ServiceOf } from "@btravstack/di";
import type { RouterContract } from "@orpc/contract";

import type { Implementation, Inherit } from "./orpc.js";

/** The top-level fragment keys `C` declares — the contract's own, less the marker's phantom key. */
export type ControllerKeyOf<C extends Record<string, RouterContract>> = Exclude<
  keyof C,
  PrincipalKey
> &
  string;

/** What a piece minted under `K` implements: the fragment, carrying the root's requirements when it declares none of its own. */
type FragmentOf<C extends Record<string, RouterContract>, K extends ControllerKeyOf<C>> = Inherit<
  C[K],
  RequirementsOf<C>
>;

/**
 * The port one piece targets. Its id carries the contract key, which is what
 * makes two slices claiming one fragment di's duplicate-provider defect rather
 * than a silent merge, and what lets the composing form recover each piece's
 * key by stripping the prefix rather than needing it spelled again.
 */
export type ControllerPortOf<
  C extends Record<string, RouterContract>,
  K extends ControllerKeyOf<C>,
  Schemes = never,
> = PortClassOf<`${typeof CONTROLLER_PREFIX}${K}`, Implementation<FragmentOf<C, K>, Schemes>>;

/** The prefix a piece's port id carries; the composing form strips it to recover the key. */
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
 * One fragment of a contract, as a provider on a port of its own.
 *
 * A large API is several pieces, each owning one top-level key of the contract
 * and declaring the use cases its procedures call;
 * `HttpRouter(contract)([...])` composes them. `contract` is read for its
 * **type** only — it is what types `key` and the handlers, so a fragment the
 * contract does not declare is refused at this call (there is nothing to type
 * the key by), and a handler whose input or output has drifted is a compile
 * error here rather than at the root.
 *
 * There is no name to give: the contract key IS the port's name, minted as
 * `` `${CONTROLLER_PREFIX}${key}` `` — the move `AmqpHandler(contract, key)`
 * and `authenticatorPort(scheme)` both make. The fragment's type carries the
 * root's requirements when it declares none of its own (`Inherit`), so a
 * root-marked contract types `context.principal` in a piece minted from it —
 * the check the retired keyed form performed at the root, now performed where
 * the handler is written.
 */
export const controllerFor =
  <Schemes>() =>
  <const C extends Record<string, RouterContract>, const K extends ControllerKeyOf<C>>(
    contract: C,
    key: K,
  ) => {
    // The parameter is named, not `_`-prefixed, so it reads as `contract` in the
    // published `.d.ts` and in an editor hint; nothing needs its value.
    void contract;
    // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
    const port = class extends Port(`${CONTROLLER_PREFIX}${key}`)<
      Implementation<FragmentOf<C, K>, Schemes>
    > {};

    // Two arms, discriminated by ARITY, mirroring `Provider(port)`'s own — a
    // controller that calls no use case is the common shape here, not an edge
    // case, and `({}, { sync })` is what it would otherwise spell.
    function build<const D extends Readonly<Record<string, AnyPort>>>(
      deps: D,
      options: {
        readonly sync: (services: {
          readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
        }) => Implementation<FragmentOf<C, K>, Schemes>;
      },
    ): Minted<C, K, Schemes, InstanceType<D[keyof D]>>;
    function build(options: {
      readonly sync: () => Implementation<FragmentOf<C, K>, Schemes>;
    }): Minted<C, K, Schemes, never>;
    function build(depsOrOptions: unknown, options?: unknown): unknown {
      return options === undefined
        ? Provider(port as never)(depsOrOptions as never)
        : Provider(port as never)(depsOrOptions as never, options as never);
    }
    return build;
  };
