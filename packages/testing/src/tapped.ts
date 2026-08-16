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
 * The returned module exports exactly what `module` exports — the kernel
 * still finds the runtime. `services()` is loud before the graph has been
 * built: reading a tap nobody booted is a bug in the test, not a modeled
 * outcome, so it throws rather than answering an `undefined` a careless
 * assertion could swallow. The gate refuses a port `module` does not export,
 * at this call site: an application-scope service is the only thing there is
 * to tap.
 */
export const tapped = <X, E, N, const P extends readonly AnyPort[]>(
  module: Module<X, E, N>,
  ports: P,
  ...gate: [Exclude<InstanceType<P[number]>, X>] extends [never]
    ? []
    : [error: "NOT EXPORTED", missing: Exclude<InstanceType<P[number]>, X>]
): { readonly module: Module<X, E, N>; readonly services: () => ServicesOf<P> } => {
  void gate;
  let services: ServicesOf<P> | undefined;
  const tap = Provider(Tap)(ports, {
    sync: (...built: readonly unknown[]) => {
      services = built as unknown as ServicesOf<P>;
      return {};
    },
  } as never);
  return {
    // The same re-export-through-import move the kernel makes to add its `Env`
    // module: `X` stays exactly what the caller composed, and the cast restates
    // that. `Tap` itself is not exported — nothing resolves it; di builds every
    // provider in the graph, exported or not, which is what makes this work.
    module: Module("Tapped")({
      imports: [module as never],
      provides: [tap],
      exports: [module as never],
    }) as unknown as Module<X, E, N>,
    services: () => {
      if (services === undefined) {
        // oxlint-disable-next-line unthrown/no-throw -- a test-only harness: reaching here means the test read the tap before booting the graph, which is a bug in the test rather than a modeled outcome, so it must be loud and not routed into a `Result` a careless assertion could swallow
        throw new Error("[testing] tapped(...).services() read before the graph was built");
      }
      return services;
    },
  };
};

// One id, declared once: two `tapped` modules in one graph are di's
// duplicate-provider defect at build, and one tap per application is the case.
class Tap extends Port("Tap")<Record<never, never>> {}
