import { Ok, type AsyncResult, type Result } from "unthrown";

import type { AnyPort, Scope, ServiceOf } from "./port.js";

/** Internal: a `deps` record — the one shape a provider declares dependencies in. */
type Deps = Readonly<Record<string, AnyPort>>;

/**
 * Internal: the services record a factory receives, keyed exactly as `deps`
 * was. Homomorphic, so the keys and their optionality survive; each value is
 * the port's service.
 */
type ServicesOf<D extends Deps> = { readonly [K in keyof D]: ServiceOf<D[K]> };

/**
 * Internal: what the factory arms are spread over. A **one-element tuple**, so
 * `Qualification`'s arms stay variadic (`(...args: Args) => S`) and become
 * `(services: ServicesOf<D>) => S` without a single arm changing — while the
 * no-deps form keeps `readonly []`, and with it a factory of no arguments.
 */
type ArgsOf<D extends Deps> = readonly [ServicesOf<D>];

/** Internal: the union of instance types a `deps` record requires. */
type NeedsOf<D extends Deps> = InstanceType<D[keyof D]>;

type ErrorOfResult<R> =
  R extends Result<unknown, infer E> ? E : R extends AsyncResult<unknown, infer E> ? E : never;

/**
 * The construction family, as mutually exclusive option shapes rather than
 * four method names. Each arm qualifies construction differently — ready,
 * sync, fallible, class — and a value can satisfy only one.
 *
 * A plain union of object types does not reject excess properties in every
 * position (only fresh-literal checks do, and only when the literal matches no
 * arm at all). Giving every arm the other keys as optional `never` makes them
 * genuinely exclusive: a literal supplying two real keys fails *both* arms it
 * might otherwise match, since the arm owning the first key requires the
 * second to be absent, and vice versa.
 */
type ValueArm<S> = {
  readonly value: S;
  readonly sync?: never;
  readonly make?: never;
  readonly class?: never;
  readonly acquire?: never;
  readonly release?: never;
};

type SyncArm<Args extends readonly unknown[], S> = {
  readonly value?: never;
  readonly sync: (...args: Args) => S;
  readonly make?: never;
  readonly class?: never;
  readonly acquire?: never;
  readonly release?: never;
};

type MakeArm<Args extends readonly unknown[], S> = {
  readonly value?: never;
  readonly sync?: never;
  // The error is bounded by `unknown`, not `never`: this arm serves both as a
  // constraint (is the option object *some* valid make arm) and, via `ErrorOf`
  // below, as the inference source for the real error type. A `never` bound
  // would make the constraint check reject any function whose `Err` branch
  // carries a real error — every useful `make` — before `ErrorOf` could read
  // it. `unknown` accepts any concrete error there while leaving the inferred
  // option type `O` holding the function's precise return type.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
  readonly make: (...args: Args) => Result<S, unknown> | AsyncResult<S, unknown>;
  readonly class?: never;
  readonly acquire?: never;
  readonly release?: never;
};

type ClassArm<Args extends readonly unknown[], S> = {
  readonly value?: never;
  readonly sync?: never;
  readonly make?: never;
  readonly class: new (...args: Args) => S;
  readonly acquire?: never;
  readonly release?: never;
};

/**
 * The resourceful arm: `acquire` is `make`'s fallible-construction twin and
 * `release` the finaliser undoing it. Both are required together — there is no
 * `release` with nothing to release, nor an `acquire` never torn down — which
 * is what makes the pair its own arm rather than an optional `release` bolted
 * onto `MakeArm`. `ScopeOf` below turns "this arm was chosen" into the `Scope`
 * phantom landing in `Needs`.
 */
type AcquireArm<Args extends readonly unknown[], S> = {
  readonly value?: never;
  readonly sync?: never;
  readonly make?: never;
  readonly class?: never;
  // Same `unknown` bound and the same reason as `MakeArm.make` above.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
  readonly acquire: (...args: Args) => Result<S, unknown> | AsyncResult<S, unknown>;
  readonly release: (service: S) => void | Promise<void>;
};

/**
 * Optional on every arm via the intersection below, rather than duplicated
 * into all five. Contributing only *optional* fields the arms don't otherwise
 * mention cannot reopen their mutual exclusivity: the `?: never` siblings that
 * make `value`/`sync`/`make`/`class`/`acquire` reject each other are
 * untouched, and a fresh literal's excess-property check still runs per
 * branch — `{ value, sync }` is rejected exactly as before (see
 * `provider.test-d.ts`, "hooks do not reopen arm exclusivity"). Not on
 * `index.ts`'s public surface: hooks are always supplied inline.
 */
type Hooks<S> = {
  readonly onStart?: (service: S) => void | Promise<void>;
  readonly onStop?: (service: S) => void | Promise<void>;
};

type Qualification<Args extends readonly unknown[], S> = (
  | ValueArm<S>
  | SyncArm<Args, S>
  | MakeArm<Args, S>
  | ClassArm<Args, S>
  | AcquireArm<Args, S>
) &
  Hooks<S>;

/**
 * Recovers the error type from a `make` arm's *actual* supplied function, not
 * the widened `unknown` bound `Qualification` checks it against. `O` is the
 * inferred argument type — untouched by the constraint check — so `infer R`
 * captures the real `Result`/`AsyncResult` returned. Arms without a `make` key
 * have `make?: never` (optional), not assignable to the required `make` this
 * pattern demands, so the conditional falls through to `never` for `value`,
 * `sync`, and `class`. Internal: only `build`'s overloads need it.
 */
type ErrorOf<O> = O extends { readonly make: (...args: never) => infer R }
  ? ErrorOfResult<R>
  : O extends { readonly acquire: (...args: never) => infer R }
    ? ErrorOfResult<R>
    : never;

/**
 * A resourceful provider requires a `Scope` on top of its declared deps.
 * Checked structurally (does `O` have an `acquire` or an `onStop` key) rather
 * than by matching a whole arm, for the same reason `ErrorOf` infers off a
 * bare `(...args: never) => infer R`: `O`'s shape, not its assignability to
 * some wider constraint, decides whether `Scope` joins `Needs`.
 *
 * `onStop` gates on `Scope` for the same reason `release` does: both are
 * teardown registered on the scope that only `Module.scoped`/`forkScope` ever
 * open and close (`lifecycle.ts`'s `constructLevel`, `module.ts`), never
 * `Module.build`. Without this arm `Provider(P)({ value, onStop })` would
 * type-check under `Module.build` with `Needs = never`, and the hook would
 * silently never run. Internal, same as `ErrorOf` above.
 */
type ScopeOf<O> = O extends { readonly acquire: unknown }
  ? Scope
  : O extends { readonly onStop: unknown }
    ? Scope
    : never;

/**
 * The package's variance rule, stated here and on `Module` (`module.ts`):
 *
 * > Capability channels (`_port`, `_exports`) are contravariant, so you may
 * > forget what you have. Obligation channels (`_error`, `_needs`) are
 * > covariant, so you may not forget what you owe.
 *
 * With `_error`/`_needs` contravariant — as they were until this fix, Task 4
 * having corrected only `Module` — an ordinary return-type annotation
 * laundered both, and with them the `Scope` that `ScopeOf` puts in `Needs`,
 * routing a resourceful provider to `Module.build` (which never closes the
 * scope it opens) and silently dropping its `release`. See the three "cannot
 * be laundered" tests in `provider.test-d.ts`.
 */
export type Provider<P, E, N> = {
  readonly _port: (p: P) => void;
  readonly _error: () => E;
  readonly _needs: () => N;
  readonly port: AnyPort;
  readonly deps: readonly AnyPort[];
  // The package's own construction boundary, not application code: a
  // `Provider` is built once per port from whatever qualification the caller
  // supplies, so its error and service types are genuinely unknown here — the
  // build pipeline narrows them back to `E`/`P` per port.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
  readonly construct: (services: readonly unknown[]) => AsyncResult<unknown, unknown>;
  readonly release: ((service: unknown) => void | Promise<void>) | undefined;
  // `onStart`/`onStop` mirror `release`'s "present only when supplied" shape;
  // `build.ts`'s pipeline fires them, this record just carries them through.
  readonly onStart: ((service: unknown) => void | Promise<void>) | undefined;
  readonly onStop: ((service: unknown) => void | Promise<void>) | undefined;
};

/**
 * `Provider<unknown, never, never>` is the *bottom* under the variance rule
 * above — contravariant `_port` takes the widest argument, covariant
 * `_error`/`_needs` return the narrowest — so it is assignable to every
 * `Provider<P, E, N>`, as an implementation signature shared by both `build`
 * overloads must be.
 */
const descriptor = (
  port: AnyPort,
  deps: readonly AnyPort[],
  keys: readonly string[],
  options: Record<string, unknown>,
): Provider<unknown, never, never> => {
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- see the field comment on `Provider.construct`
  const construct = (services: readonly unknown[]): AsyncResult<unknown, unknown> => {
    if ("value" in options) return Ok(options["value"]).toAsync();
    // The build pipeline resolves `deps` positionally, so the record the caller
    // declared is rebuilt here, under the names they wrote. `args` is what every
    // arm below spreads: one element for a provider with deps, none without —
    // which is why a no-deps factory still takes no arguments.
    const args: readonly unknown[] =
      keys.length === 0
        ? []
        : [Object.fromEntries(keys.map((key, index) => [key, services[index]]))];
    if ("sync" in options) {
      const f = options["sync"] as (...a: readonly unknown[]) => unknown;
      return Ok()
        .toAsync()
        .map(() => f(...args));
    }
    if ("class" in options) {
      const C = options["class"] as new (...a: readonly unknown[]) => unknown;
      return Ok()
        .toAsync()
        .map(() => new C(...args));
    }
    // Whichever of `make`/`acquire` was supplied — `Qualification`'s
    // exclusivity guarantees at most one — is the fallible path. `acquire` is
    // `make` with a finaliser attached; construction works identically either
    // way.
    const f = (options["acquire"] ?? options["make"]) as (
      ...a: readonly unknown[]
      // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- see the field comment on `Provider.construct`
    ) => Result<unknown, unknown> | AsyncResult<unknown, unknown>;
    // Lifting through an Ok keeps a sync Result and an AsyncResult on one path,
    // with no runtime type-sniffing — the same trick demesne (this library's retired predecessor) used in Layer.make.
    return Ok()
      .toAsync()
      .flatMap(() => f(...args));
  };
  return {
    port,
    deps,
    construct,
    // Only the `acquire` arm sets this; every other arm carries `undefined`,
    // which is how `constructLevel` (`lifecycle.ts`) decides whether a
    // constructed service has anything to register with the scope.
    release: options["release"] as ((service: unknown) => void | Promise<void>) | undefined,
    onStart: options["onStart"] as ((service: unknown) => void | Promise<void>) | undefined,
    onStop: options["onStop"] as ((service: unknown) => void | Promise<void>) | undefined,
  } as unknown as Provider<unknown, never, never>;
};

export function Provider<P extends AnyPort, S = ServiceOf<P>>(port: P) {
  // `& { readonly port: P }`: the provider carries the very port class it was
  // declared for, typed — so a provider a helper hands back on a port the
  // caller never spelled (a starter's `HttpRouter(contract)(deps, arm)`,
  // `Config.provider(name)(schema)`) is the one value an application needs to
  // hold: `provider.port`
  // is what another provider lists in its deps or a starter reads the port
  // off. Purely additive — the intersection is still a `Provider<P, E, N>`.
  function build<const D extends Deps, O extends Qualification<ArgsOf<D>, S>>(
    deps: D,
    options: O,
  ): Provider<InstanceType<P>, ErrorOf<O>, NeedsOf<D> | ScopeOf<O>> & { readonly port: P };
  function build<O extends Qualification<readonly [], S>>(
    options: O,
  ): Provider<InstanceType<P>, ErrorOf<O>, ScopeOf<O>> & { readonly port: P };
  function build(
    depsOrOptions: Deps | Record<string, unknown>,
    maybeOptions?: Record<string, unknown>,
  ): Provider<unknown, never, never> & { readonly port: P } {
    // ARITY discriminates, not the argument's shape: a `deps` record and an
    // options object are both non-array objects, so there is nothing to sniff.
    // Two arguments means the first is `deps`; one means it is the options of a
    // provider that declares none.
    if (maybeOptions === undefined) {
      return descriptor(port, [], [], depsOrOptions as Record<string, unknown>) as Provider<
        unknown,
        never,
        never
      > & { readonly port: P };
    }
    // `Object.entries` fixes the order once, here: `deps` reaches the build
    // pipeline as the array it resolves positionally, and `keys` is what lets
    // `construct` put the resolved services back under the names the caller
    // wrote.
    const entries = Object.entries(depsOrOptions as Deps);
    return descriptor(
      port,
      entries.map(([, dependency]) => dependency),
      entries.map(([key]) => key),
      maybeOptions,
    ) as Provider<unknown, never, never> & { readonly port: P };
  }
  return build;
}
