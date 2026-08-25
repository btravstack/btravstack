import { Module, overrideProvider, type Provider } from "@btravstack/di";

/** One override's error channel, unioned across the tuple by `overridden`. */
type ErrorsOf<O extends readonly AnyProviderFor[]> =
  O[number] extends Provider<never, infer E, unknown> ? E : never;
/** The widest provider `overridden` accepts — variance makes every real one assignable. */
type AnyProviderFor = Provider<never, unknown, unknown>;

/**
 * The real composition root, with named providers substituted — the testing half
 * of "swapping an adapter is composing a different module", for the seam
 * composition cannot reach: nothing can be layered over a graph that already
 * provides a port, so the alternative was a parallel root that drifted silently.
 *
 * Each override is an ordinary `Provider(Port)(...)`, so the service type is
 * checked against the port at that call. At run time an override REPLACES the
 * base provider — the base is never constructed — and an override for a port the
 * tree no longer provides is a `WiringDefect` ("nothing to override"), which is
 * what turns fixture drift into a loud failure.
 *
 * It replaces ONE provider, never a subsystem: the replaced provider's siblings
 * still construct, so swapping a whole adapter stack remains a different module
 * composed in its place.
 *
 * An override's own deps deliberately do NOT widen the returned `Needs`: they
 * resolve from the graph's INTERNALS, and typing them into `N` would force a
 * root to re-export internals to be overridable. They are checked at build
 * instead, by `plan`'s missing-provider defect.
 */
export const overridden = <X, E, N, const O extends readonly AnyProviderFor[]>(
  module: Module<X, E, N>,
  overrides: O,
): Module<X, E | ErrorsOf<O>, N> =>
  // Re-exported through the import, as `tapped` does: `X` stays what the caller
  // composed, and the `as never`s are di's gates deferring while `X`/`N` are
  // type parameters.
  Module("Overridden")({
    imports: [module as never],
    provides: overrides.map((override) => overrideProvider(override as never)),
    exports: [module as never],
  } as never) as unknown as Module<X, E | ErrorsOf<O>, N>;
