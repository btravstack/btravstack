import {
  Port,
  Provider,
  type AnyPort,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";
import type { RouterContract } from "@orpc/contract";

import type { Implementation } from "./orpc.js";

/**
 * One slice of a contract, as a provider on a port of its own.
 *
 * A large API is several controllers, each owning a fragment of the contract
 * and declaring the use cases its procedures call; `HttpRouter(contract)(...)`
 * composes them. `contract` is read for its **type** only — it is what shapes
 * `sync`, so a procedure the fragment does not declare, or a handler whose
 * input or output has drifted, is a compile error here rather than at the root.
 *
 * The port is minted for you and carried back on `provider.port`, the same
 * shape `Config.provider("RelayConfig")(schema)` returns: there is nothing to
 * name twice. It is spelled through di's `PortInstance` / `PortClassOf` rather
 * than the class expression's own type because a class expression is anonymous
 * and a consumer that exports the provider cannot emit its declaration (TS4023,
 * measured on `examples/order-api`).
 */
/** What both arms of a minted controller return; `N` is the only thing that differs. */
type Minted<Name extends string, C extends RouterContract, Identity, N> = Provider<
  PortInstance<Name, Implementation<C, Identity>>,
  never,
  N
> & { readonly port: PortClassOf<Name, Implementation<C, Identity>> };

export const controllerFor =
  <Identity>() =>
  <const Name extends string, C extends RouterContract>(name: Name, contract: C) => {
    // The parameter is named, not `_`-prefixed, so it reads as `contract` in the
    // published `.d.ts` and in an editor hint; nothing needs its value.
    void contract;
    // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
    const port = class extends Port(name)<Implementation<C, Identity>> {};

    // Two arms, discriminated by ARITY, mirroring `Provider(port)`'s own —
    // a controller that calls no use case is the common shape here, not an
    // edge case, and `({}, { sync })` is what it would otherwise have to
    // spell. Delegating both to di's `build` is also what keeps the
    // no-deps factory taking no argument at all.
    function build<const D extends Readonly<Record<string, AnyPort>>>(
      deps: D,
      options: {
        readonly sync: (services: {
          readonly [K in keyof D]: ServiceOf<InstanceType<D[K]>>;
        }) => Implementation<C, Identity>;
      },
    ): Minted<Name, C, Identity, InstanceType<D[keyof D]>>;
    function build(options: {
      readonly sync: () => Implementation<C, Identity>;
    }): Minted<Name, C, Identity, never>;
    function build(depsOrOptions: unknown, options?: unknown): unknown {
      return options === undefined
        ? Provider(port as never)(depsOrOptions as never)
        : Provider(port as never)(depsOrOptions as never, options as never);
    }
    return build;
  };

/**
 * The controller, with no server-side identity: a handler under a marked
 * fragment sees `principal: never`, so any read of it is a compile error —
 * the "use the factory" signal. `httpAuth<Identity>()` mints the form whose
 * handlers see the application's own principal.
 */
export const HttpController: ReturnType<typeof controllerFor<never>> = controllerFor<never>();
