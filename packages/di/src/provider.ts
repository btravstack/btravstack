import { Ok, type AsyncResult, type Result } from "unthrown";

import type { AnyPort, MemberOf, Scope, ServiceOf } from "./port.js";

/** Internal: a `deps` record — the one shape a provider declares dependencies in. */
type Deps = Readonly<Record<string, AnyPort>>;

/**
 * Internal: the services record a factory receives, keyed exactly as `deps` was.
 * Homomorphic, so the keys and their optionality survive.
 */
type ServicesOf<D extends Deps> = { readonly [K in keyof D]: ServiceOf<D[K]> };

/** Internal: the union of instance types a `deps` record requires. */
type NeedsOf<D extends Deps> = InstanceType<D[keyof D]>;

type ErrorOfResult<R> =
  R extends Result<unknown, infer E> ? E : R extends AsyncResult<unknown, infer E> ? E : never;

/**
 * The construction family, as mutually exclusive option shapes rather than four
 * method names. Each arm gives the others their keys as optional `never`: a
 * plain union does not reject excess properties in every position, and this
 * makes a literal supplying two real keys fail both arms it might match.
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
  // Bounded by `unknown`, not `never`: this arm is both the constraint and
  // `ErrorOf`'s inference source, and a `never` bound would reject every
  // function whose `Err` branch carries a real error.
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
 * The resourceful arm: `acquire` is `make`'s fallible twin and `release` the
 * finaliser undoing it. Both are required together, which is what makes the
 * pair its own arm rather than an optional `release` on `MakeArm`.
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
 * Optional on every arm through the intersection below. Contributing only
 * optional fields cannot reopen the arms' mutual exclusivity — the `?: never`
 * siblings are untouched.
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
 * Recovers the error type from the supplied function rather than the widened
 * `unknown` bound the constraint checks against. Arms with no `make` key have
 * `make?: never`, which this required-key pattern does not match, so they fall
 * through to `never`.
 */
type ErrorOf<O> = O extends { readonly make: (...args: never) => infer R }
  ? ErrorOfResult<R>
  : O extends { readonly acquire: (...args: never) => infer R }
    ? ErrorOfResult<R>
    : never;

/**
 * A resourceful provider requires a `Scope` on top of its declared deps,
 * checked structurally rather than by matching a whole arm.
 *
 * `onStop` gates on `Scope` for the same reason `release` does: both are
 * teardown registered on the scope only `Module.scoped`/`forkScope` open.
 * Without this arm `Provider(P)({ value, onStop })` would type-check under
 * `Module.build` and the hook would silently never run.
 */
type ScopeOf<O> = O extends { readonly acquire: unknown }
  ? Scope
  : O extends { readonly onStop: unknown }
    ? Scope
    : never;

/**
 * The package's variance rule, stated here and on `Module`: capability channels
 * (`_port`) are contravariant, obligation channels (`_error`, `_needs`)
 * covariant.
 *
 * With the obligation channels contravariant an ordinary return-type annotation
 * laundered both — and with them the `Scope` `ScopeOf` puts in `Needs`, routing
 * a resourceful provider to `Module.build`, which never closes the scope it
 * opens, and silently dropping its `release`.
 */
export type Provider<P, E, N> = {
  readonly _port: (p: P) => void;
  readonly _error: () => E;
  readonly _needs: () => N;
  readonly port: AnyPort;
  readonly deps: readonly AnyPort[];
  // The package's own construction boundary, not application code: the build
  // pipeline narrows these back to `E`/`P` per port.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
  readonly construct: (services: readonly unknown[]) => AsyncResult<unknown, unknown>;
  readonly release: ((service: unknown) => void | Promise<void>) | undefined;
  readonly onStart: ((service: unknown) => void | Promise<void>) | undefined;
  readonly onStop: ((service: unknown) => void | Promise<void>) | undefined;
};

/**
 * `Provider<unknown, never, never>` is the bottom under the variance rule above,
 * so it is assignable to every `Provider<P, E, N>` — as an implementation
 * signature shared by both `build` overloads must be.
 */
const descriptor = (
  port: AnyPort,
  deps: readonly AnyPort[],
  // `undefined` for the no-deps overload, an array — possibly EMPTY — for the
  // one that declares a record. Arity, not key count: `Provider(P)({}, arm)`
  // declared a record and its factory is handed one.
  keys: readonly string[] | undefined,
  options: Record<string, unknown>,
): Provider<unknown, never, never> => {
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- see the field comment on `Provider.construct`
  const construct = (services: readonly unknown[]): AsyncResult<unknown, unknown> => {
    if ("value" in options) return Ok(options["value"]).toAsync();
    // The build pipeline resolves `deps` positionally, so the record the caller
    // declared is rebuilt here under the names they wrote. One element for a
    // provider with deps, none without.
    const args: readonly unknown[] =
      keys === undefined
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
    const f = (options["acquire"] ?? options["make"]) as (
      ...a: readonly unknown[]
      // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- see the field comment on `Provider.construct`
    ) => Result<unknown, unknown> | AsyncResult<unknown, unknown>;
    // Lifting through an Ok keeps a sync Result and an AsyncResult on one path,
    // with no runtime type-sniffing.
    return Ok()
      .toAsync()
      .flatMap(() => f(...args));
  };
  return {
    port,
    deps,
    construct,
    // Only the `acquire` arm sets this; `undefined` everywhere else is how
    // `constructLevel` decides whether to register a finaliser with the scope.
    release: options["release"] as ((service: unknown) => void | Promise<void>) | undefined,
    onStart: options["onStart"] as ((service: unknown) => void | Promise<void>) | undefined,
    onStop: options["onStop"] as ((service: unknown) => void | Promise<void>) | undefined,
  } as unknown as Provider<unknown, never, never>;
};

/**
 * The override brand, and the one place it can be applied. An override REPLACES
 * the base provider for its port at plan time — the base is never constructed —
 * instead of colliding with it. An override with no base is a `WiringDefect`
 * ("nothing to override"), which turns a drifted fixture into a loud failure.
 *
 * Test-harness-facing: `@btravstack/testing`'s `overridden` is the intended
 * caller. Production composition swaps an adapter by composing a different
 * module.
 */
const OVERRIDE = Symbol("di.override");

export const overrideProvider = <P, E, N>(provider: Provider<P, E, N>): Provider<P, E, N> =>
  ({ ...provider, [OVERRIDE]: true }) as Provider<P, E, N>;

/** Package-private (not in `index.ts`): `build.ts`'s plan resolves with it. */
export const isOverride = (provider: object): boolean => OVERRIDE in provider;

// `S` is a second, defaulted type parameter rather than `ServiceOf<P>` inline,
// so `Provider.member` can instantiate it as `MemberOf<P>` — one contribution's
// shape, not the `readonly Member[]` the set port resolves to.
function ProviderDeclaration<P extends AnyPort, S = ServiceOf<P>>(port: P) {
  // `& { readonly port: P }` carries the port class typed, so a provider a
  // helper hands back on a port the caller never spelled is the one value an
  // application needs to hold. Purely additive.
  function build<const D extends Deps, O extends Qualification<readonly [ServicesOf<D>], S>>(
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
    // ARITY discriminates, not shape: a `deps` record and an options object are
    // both non-array objects, so there is nothing to sniff.
    if (maybeOptions === undefined) {
      return descriptor(port, [], undefined, depsOrOptions as Record<string, unknown>) as Provider<
        unknown,
        never,
        never
      > & { readonly port: P };
    }
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

/**
 * `Provider.member`'s port is bound by the structural `AnyPort`, not
 * `ManyPortClass<string>`: a concrete set-port class has a concrete
 * constructor once `Member` is fixed, so — exactly as with `PortClass` — it is
 * not assignable to the generic form, and binding it that way would reject
 * every real call site.
 *
 * Instantiating `S` as `MemberOf<P>` is the whole difference: it qualifies an
 * arm against ONE member's shape. The runtime body is the ordinary factory's;
 * `context.ts`'s `unsafeAddAll` is what turns a member into an array entry.
 */
export const Provider = Object.assign(ProviderDeclaration, {
  member: <P extends AnyPort>(port: P) => ProviderDeclaration<P, MemberOf<P>>(port),
});
