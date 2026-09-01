import { Module, Port, Provider, type AnyPort, type ServiceOf } from "@btravstack/di";

/** The services behind `ports`, in order — what `tapped(...).services()` answers once the graph is built. */
export type ServicesOf<P extends readonly AnyPort[]> = {
  readonly [K in keyof P]: ServiceOf<InstanceType<P[K]>>;
};

/**
 * Read services out of a booted application.
 *
 * `start` hands the application context to the runtime alone, so a test that
 * wants the very `Logger` the use cases write to — not a fresh one — has no
 * `ctx.get` to reach it with. `tapped` composes one more provider around
 * `module`, depending on `ports`, and remembers what it was built with:
 *
 * ```ts
 * const tap = tapped(OrderApi, [Logger]);
 * const app = boot(tap.module);
 * await client.orders.place({ id: "o-1", quantity: 2 });
 * const [logger] = tap.services();
 * expect(logger.lines()).toContain(…);
 * ```
 *
 * The returned module exports exactly what `module` exports, so the kernel still
 * finds the runtime. `services()` is loud before the graph has been built:
 * reading a tap nobody booted is a bug in the test, and an `undefined` a
 * careless assertion could swallow is worse than a throw. The gate refuses a
 * port `module` does not export — an application-scope service is the only thing
 * there is to tap.
 */
type TapGate<P extends readonly AnyPort[], X> = [Exclude<InstanceType<P[number]>, X>] extends [
  never,
]
  ? unknown
  : {
      readonly "NOT EXPORTED — tap only what the module exports": Exclude<
        InstanceType<P[number]>,
        X
      >;
    };

export const tapped = <X, E, N, const P extends readonly AnyPort[]>(
  module: Module<X, E, N>,
  ports: P & TapGate<P, X>,
): { readonly module: Module<X, E, N>; readonly services: () => ServicesOf<P> } => {
  let services: ServicesOf<P> | undefined;
  // `ports` stays an array — it is what `services()` answers positionally.
  // Index keys are the translation into the record `Provider` takes, and what
  // put the services back in `ports` order.
  const tap = Provider(Tap)({
    inject: Object.fromEntries(ports.map((port, index) => [index, port])),
    sync: (built: Record<number, unknown>) => {
      services = ports.map((_, index) => built[index]) as unknown as ServicesOf<P>;
      return {};
    },
  } as never);
  return {
    // Re-exported through the import, so `X` stays what the caller composed.
    // `Tap` is never exported: di builds every provider in the graph, exported
    // or not, which is what makes this work. The `as never` is di's `needs`
    // gate deferring while `X`/`N` are type parameters; the wrapper adds none.
    module: Module("Tapped")({
      imports: [module as never],
      provides: [tap],
      exports: [module as never],
    } as never) as unknown as Module<X, E, N>,
    services: () => {
      if (services === undefined) {
        // oxlint-disable-next-line unthrown/no-throw -- a test-only harness: reaching here means the test read the tap before booting the graph, which is a bug in the test rather than a modeled outcome, so it must be loud and not routed into a `Result` a careless assertion could swallow
        throw new Error("[testing] tapped(...).services() read before the graph was built");
      }
      return services;
    },
  };
};

// NAMESPACED because this port is invisible to the application that would
// collide with it: a bare `Port("Tap")` is a plausible application name, and
// di's duplicate-id warning would name an id a test never wrote.
class Tap extends Port("@btravstack/testing/Tap")<Record<never, never>> {}
