import { Module, overrideProvider, type Provider } from "@btravstack/di";

/** One override's error channel, unioned across the tuple by `overridden`. */
type ErrorsOf<O extends readonly AnyProviderFor[]> =
  O[number] extends Provider<never, infer E, unknown> ? E : never;
/** The widest provider `overridden` accepts — variance makes every real one assignable. */
type AnyProviderFor = Provider<never, unknown, unknown>;

/**
 * The real composition root, with named providers substituted — the testing
 * half of "swapping an adapter is composing a different module", for the seam
 * composition cannot reach: nothing can be layered over a graph that already
 * provides a port (di's duplicate defect is what makes that true), so before
 * this helper a recording sink or a stubbed adapter meant a hand-maintained
 * parallel root that restated the real one and drifted from it silently.
 *
 * Each override is an ordinary `Provider(Port)(...)` — the service type is
 * checked against the port at that call, which is the compile-time half. The
 * runtime half is di's: an override REPLACES the base provider for its port
 * (the base is never constructed — a resourceful base's `acquire` never
 * runs), and an override for a port the tree no longer provides is a
 * `WiringDefect` ("nothing to override"), so a fixture that drifts from the
 * root it overrides fails loudly instead of diverging.
 *
 * What an override cannot check is whether the resulting graph still makes
 * sense — the same honest cost `tapped` accepts. And it replaces ONE
 * provider, never a subsystem: the replaced provider's siblings still
 * construct (override `OrderRepository` and the database client behind the
 * real one still opens), so swapping a whole adapter stack remains a
 * different module composed in its place.
 *
 * An override's own deps deliberately do NOT widen the returned `Needs`:
 * they are meant to resolve from the graph's INTERNALS (a recording logger
 * reading the real `LoggerConfig`), and typing them into `N` would force a
 * root to re-export internals to be overridable. They are checked at build
 * instead — a dep no provider in the tree supplies is `plan`'s own
 * missing-provider `WiringDefect`, before any factory runs.
 */
export const overridden = <X, E, N, const O extends readonly AnyProviderFor[]>(
  module: Module<X, E, N>,
  overrides: O,
): Module<X, E | ErrorsOf<O>, N> =>
  // The same re-export-through-import move `tapped` makes: `X` stays exactly
  // what the caller composed, and the `as never`s restate that di's declared
  // gates cannot be computed while `X`/`N` are still type parameters — the
  // overrides' own deps are validated at build by the missing-provider
  // defect, never represented in `N` (see the TSDoc above).
  Module("Overridden")({
    imports: [module as never],
    provides: overrides.map((override) => overrideProvider(override as never)),
    exports: [module as never],
  } as never) as unknown as Module<X, E | ErrorsOf<O>, N>;
