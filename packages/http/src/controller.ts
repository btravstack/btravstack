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
export const HttpController =
  <const Name extends string, C extends RouterContract>(name: Name, contract: C) =>
  <const D extends readonly AnyPort[]>(
    deps: D,
    options: {
      readonly sync: (
        ...services: { [K in keyof D]: ServiceOf<InstanceType<D[K]>> }
      ) => Implementation<C>;
    },
  ): Provider<PortInstance<Name, Implementation<C>>, never, InstanceType<D[number]>> & {
    readonly port: PortClassOf<Name, Implementation<C>>;
  } => {
    // The parameter is named, not `_`-prefixed, so it reads as `contract` in the
    // published `.d.ts` and in an editor hint; nothing needs its value.
    void contract;
    // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
    const port = class extends Port(name)<Implementation<C>> {};
    return Provider(port as never)(deps, options as never) as never;
  };
