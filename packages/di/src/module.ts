import type { AsyncResult } from "unthrown";

import { run, runScoped, type ScopedOptions } from "./build.js";
import { type Context } from "./context.js";
import type { AnyPort, Scope } from "./port.js";
import type { Provider } from "./provider.js";
import { createScope } from "./scope.js";

/**
 * Structural bounds, not `Provider<any, any, any>` / `Module<any, any, any>`
 * as the brief has it. The phantom channels carry *mixed* variance by design —
 * capability channels (`_port`, `_exports`) contravariant, obligation channels
 * (`_error`, `_needs`) covariant, see `Module` below — and these bounds only
 * need the shape every provider and module has in common regardless of its
 * channels. Listing the concrete (non-phantom) fields structurally keeps the
 * comparison channel-free, so nothing here can trip on a variance rule it does
 * not care about.
 *
 * The wildcarded bound was originally rejected outright: while `_error`/`_needs`
 * were still contravariant, `Provider<Env, never, never>` failed to satisfy
 * `Provider<any, any, any>` with "Type 'any' is not assignable to type
 * 'never'". Covariant obligation channels ended that, and the wildcarded form
 * would compile today (measured) — it stays gone because `any` is a lint error
 * in this repo, and because a bound that compares channels it does not read is
 * a variance bug waiting for the next rule change.
 */
export type AnyProvider = { readonly port: AnyPort; readonly deps: readonly AnyPort[] };

export type AnyModule = {
  readonly name: string;
  readonly imports: readonly AnyModule[];
  readonly provides: readonly AnyProvider[];
  readonly exports: readonly (AnyPort | AnyModule)[];
};

/**
 * Recovers `Provider`'s/`Module`'s channels by inferring all three
 * positions at once and reading the result positionally, the same
 * `ChannelsOf` trick `provider.test-d.ts` uses for tests. The brief's
 * version inferred one position while fixing the other two to `unknown`
 * (e.g. `P extends Provider<unknown, infer E, unknown> ? E : never`) — that
 * also fails under this TypeScript version: matching a contravariant field
 * whose real parameter type is concrete (e.g. `ConfigError`) against a
 * fixed `unknown` in the pattern requires `unknown` to be assignable to
 * `ConfigError`, which is false, so the whole `extends` check fails and the
 * conditional silently falls through to `never` for every real provider or
 * module. Inferring every position sidesteps the comparison entirely: each
 * inferred type variable matches its own field exactly, regardless of
 * variance.
 */
type ProviderChannels<T> =
  T extends Provider<infer P, infer E, infer N> ? readonly [P, E, N] : never;
type PortOf<T> = ProviderChannels<T>[0];
type ErrOf<T> = ProviderChannels<T>[1];
type NeedOf<T> = ProviderChannels<T>[2];

type ModuleChannels<T> = T extends Module<infer X, infer E, infer N> ? readonly [X, E, N] : never;
type ExportsOfModule<T> = ModuleChannels<T>[0];
type ErrOfModule<T> = ModuleChannels<T>[1];
type NeedsOfModule<T> = ModuleChannels<T>[2];

/**
 * The variance rule, stated once and shared with `Provider` (see the identical
 * note above `Provider`'s own phantom fields in `provider.ts`):
 *
 * > Capability channels (`_port`, `_exports`) are contravariant, so you may
 * > forget what you have. Obligation channels (`_error`, `_needs`) are
 * > covariant, so you may not forget what you owe.
 *
 * Each field's own comment below says why that direction is the right one for
 * that channel; this is the one-line rule they are instances of. It is stated
 * here and in `provider.ts` because its absence is exactly how `Provider` came
 * to drift from `Module` after Task 4 fixed only the latter.
 */
export type Module<Exports, E, Needs> = {
  readonly _exports: (x: Exports) => void;
  // Covariant (return position), not contravariant like `_exports`/`_needs`
  // and unlike `Provider`'s `_error`. The brief's own test "E is not
  // narrowable to one arm" assigns a module whose real error channel is
  // `ConfigError | PoolError` into a variable declared as `Module<_,
  // PoolError, _>` and expects rejection via `@ts-expect-error`. With a
  // contravariant `(e: E) => void` field that assignment *succeeds*:
  // checking function-parameter contravariance reduces to "is `PoolError`
  // assignable to `ConfigError | PoolError`", which is true regardless of
  // the dropped member, so the narrowing silently passes (confirmed with a
  // minimal `tsc --strict` repro). A covariant `() => E` field instead
  // reduces the same assignment to "is `ConfigError | PoolError` assignable
  // to `PoolError`", which correctly fails. `_exports` keeps the
  // contravariant shape because its brief test goes the other way
  // ("internal port is not in Exports" declares a *wider* Exports than
  // actual and expects rejection, which contravariance does catch).
  readonly _error: () => E;
  // Covariant (return position), not contravariant. `Needs` is a
  // *requirements* channel (compare Effect's `out R`): a module that still
  // needs a `Database` must not be substitutable where a module needing
  // nothing (`never`) is expected — that would launder an unmet dependency
  // past Task 5's build gate, defeating the whole point of catching missing
  // dependencies at compile time. With `(n: Needs) => void` (contravariant),
  // `Module<X, E, Database>` *is* assignable to `Module<X, E, never>`:
  // checking function-parameter contravariance reduces to "is `never`
  // assignable to `Database`", which is trivially true, so the laundering
  // silently succeeds. `() => Needs` (covariant) instead reduces the same
  // check to "is `Database` assignable to `never`", which correctly fails.
  // See "an unmet requirement cannot be laundered to no requirement" below.
  readonly _needs: () => Needs;
  readonly name: string;
  readonly imports: readonly AnyModule[];
  readonly provides: readonly AnyProvider[];
  readonly exports: readonly (AnyPort | AnyModule)[];
};

/** Everything visible inside the module: what it provides plus what its imports export. */
type Available<I extends readonly AnyModule[], P extends readonly AnyProvider[]> =
  | ExportsOfModule<I[number]>
  | PortOf<P[number]>;

/**
 * An export entry is legal only if it is an available port, a provider for one
 * (normalised to `provider.port` by `ModuleDeclaration` below), or an imported
 * module (whole-module re-export).
 *
 * The provider arm exists because the helpers that mint their own port —
 * `Config.provider(name)(schema)`, a starter's `HttpRouter(contract)(…)` —
 * hand back a provider and no class to name, so `exports: [ordersController]`
 * is the only spelling that does not go back through `.port`. It is
 * `AnyProvider &`, not a bare `{ port }`, so nothing but a provider matches.
 *
 * The intersection `AnyPort & (new () => Available<I, P>)` checks a
 * candidate port class's *constructor return type* — its instance type —
 * against the `Available` union. Return-type position is covariant, so it
 * is unaffected by the contravariant-field quirk above: `AppConfig`'s
 * instance type is `PortInstance<"MAppConfig", Shape>`, branded by the
 * literal id, so it is only assignable into `Available<I, P>` when some
 * available port shares that exact id. That is a genuine check, not a
 * vacuous one — a port that is not available fails it.
 *
 * This must stay a plain union member, not a generic helper invoked with
 * `AnyPort` as its argument: instantiating a per-element conditional with
 * the whole `AnyPort` union (rather than letting each array element be
 * checked against the intersection directly) tests whether *every* possible
 * port is available, which is never true and rejects legal exports too.
 * Checked directly like this, TypeScript validates each array element
 * against the intersection individually when the `exports` literal is
 * checked against `readonly Exportable<I, P>[]`.
 */
export type Exportable<I extends readonly AnyModule[], P extends readonly AnyProvider[]> =
  | (AnyPort & (new () => Available<I, P>))
  | (AnyProvider & { readonly port: AnyPort & (new () => Available<I, P>) })
  | I[number];

type ResolvedExports<X extends readonly unknown[]> =
  | (X[number] extends infer E
      ? E extends AnyPort
        ? InstanceType<E>
        : // A provider contributes its port's instance type, so exporting a
          // provider and exporting its port class yield the identical channel.
          E extends AnyProvider
          ? InstanceType<E["port"]>
          : never
      : never)
  | ExportsOfModule<Extract<X[number], AnyModule>>;

/**
 * What the module still owes: its providers' dependencies and its imports'
 * own needs, minus everything visible to it. This is the `Needs` CHANNEL —
 * everything outstanding, however it got there — and is deliberately wider
 * than what `NeedsGate` makes a module declare, which is its own providers'
 * half alone. Exported because a shaped module — a starter's
 * `HttpModule(name)({...})` — re-declares this package's gates over its own
 * augmented tuples, the way it already re-declares `Exportable`.
 */
export type Unmet<I extends readonly AnyModule[], P extends readonly AnyProvider[]> = Exclude<
  NeedOf<P[number]> | NeedsOfModule<I[number]>,
  Available<I, P>
>;

/**
 * The declaration gate. A port **this module's own providers** read, and that
 * nothing here satisfies, is an error unless it is named in `needs` — so a
 * provider can never silently receive a service from whoever composed the
 * module. `needs` is how a module says "my composition root supplies this"
 * out loud, the explicit stand-in for NestJS's `@Global`, which this package
 * does not have and does not need.
 *
 * **An import's own unmet needs are NOT this module's to re-declare**, and
 * that is the deliberate half. They are already published in the import's
 * type — `Module<X, E, Env>` says so at the `imports` entry a reader is
 * looking at — and `start` still refuses a root that has not discharged them,
 * so nothing is hidden by leaving them out. What re-declaring them bought was
 * one line per module per hop: measured on this repo, 12 of 22 declarations
 * were pure propagation, and dropping them leaves exactly the modules that
 * actually read the port. `Env` is the one that showed it — six declarations
 * in `order-api`, one of them the feature that reads `DATABASE_URL`.
 *
 * `Scope` is the one exemption, and it is forced rather than chosen: nothing
 * can provide `Scope` — a provider for it is a `WiringDefect` — so it is never
 * something an ancestor supplies. `Module.scoped` and `start` discharge it by
 * opening one.
 *
 * It rides an intersection on the options parameter, the technique
 * `@btravstack/core`'s `StartGate` uses — `unknown` when satisfied, so the
 * parameter type is untouched. It is an object with one required property
 * rather than `StartGate`'s bare string, because that is what makes the
 * diagnostic name the port (measured):
 *
 * ```
 * Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
 *   '{ provides: [...]; exports: [...]; }' but required in type
 *   '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
 * ```
 *
 * A bare string prints the sentence twice and never names `Logger`, which is
 * the only question the reader actually has. Do not "simplify" it back.
 */
export type NeedsGate<
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  N extends readonly AnyPort[],
> = [Exclude<NeedOf<P[number]>, Available<I, P>>] extends [InstanceType<N[number]> | Scope]
  ? unknown
  : {
      // Inline, not a named alias: an alias prints as itself, unreduced, and
      // the reader is left reading their own tuples back. Written out, the
      // message ends on the port (measured, both ways).
      readonly "UNDECLARED NEEDS — name it in `needs`": Exclude<
        Exclude<NeedOf<P[number]>, Available<I, P>>,
        InstanceType<N[number]> | Scope
      >;
    };

/**
 * Renamed from the brief's plain exported `Module` function: the "operations
 * namespaced on the constructor" convention (`Module.build`, below) needs a
 * value distinct from this one to `Object.assign` the namespace onto —
 * assigning a property onto the function TypeScript infers for a generic
 * `export function Module(...)` does not let the result keep that generic
 * call signature. Kept unexported; `Module` (the merged const below) is the
 * only public entry point.
 */
function ModuleDeclaration<const Name extends string>(name: Name) {
  return <
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<I, P>[] = [],
    const N extends readonly AnyPort[] = [],
  >(
    options: {
      readonly imports?: I;
      readonly provides?: P;
      readonly exports?: X;
      readonly needs?: N;
    } & NeedsGate<I, P, N>,
    // Inline, NOT `Unmet<I, P>`: declaration emit keeps a named alias
    // unreduced, and the unreduced form names the imported modules' internal
    // ports — TS2883/TS4023 on the first consumer that exports a composition
    // root (measured: `OrderApi` "cannot be named without a reference to
    // 'OrderDatabase'"). `Unmet` is the same computation, used only where it
    // stays inside a parameter type.
  ): Module<
    ResolvedExports<X>,
    ErrOf<P[number]> | ErrOfModule<I[number]>,
    Exclude<NeedOf<P[number]> | NeedsOfModule<I[number]>, Available<I, P>>
  > =>
    ({
      name,
      imports: options.imports ?? [],
      provides: options.provides ?? [],
      // Normalised here, not read lazily: `exports` is declared
      // `readonly (AnyPort | AnyModule)[]` on both `Module` and `AnyModule`,
      // and a starter's shaped module spreads it into its own array.
      exports: (options.exports ?? []).map((entry) => ("port" in entry ? entry.port : entry)),
    }) as never;
}

/**
 * `Module.build` sorts the tree into dependency-ordered levels, checks for
 * wiring bugs (cycles, duplicate providers) before any factory runs, then
 * constructs level by level. See `build.ts` for the implementation; this is
 * just the typed entry point, namespaced on `Module` per the package's
 * convention of hanging operations off the type's constructor.
 *
 * The rest parameter is the compile-time gate for unmet dependencies: when
 * `N` (the module's remaining `Needs`) is `never`, `..._missing` is typed as
 * the empty tuple `[]`, so `Module.build(mod)` is a normal one-argument call.
 * When `N` is not `never`, the tuple has two *required* elements, so calling
 * with just `mod` is an arity error — the module's unmet dependency becomes a
 * compile error at the call site, not a runtime surprise.
 */
export const Module = Object.assign(ModuleDeclaration, {
  build: <X, E, N>(
    module: Module<X, E, N>,
    ..._missing: [N] extends [never] ? [] : [error: "UNSATISFIED DEPENDENCIES", missing: N]
  ): AsyncResult<Context<X>, E> => run(module as never, createScope()) as never,

  /**
   * `Module.build`'s resourceful counterpart: opens a scope, runs the module,
   * hands the built `Context` to `use`, and closes the scope — releasing
   * every already-acquired resource, LIFO — on every path out, whether
   * construction failed, `use` failed, or `use` succeeded. See
   * `build.ts`'s `runScoped` for the unwind itself.
   *
   * The gate mirrors `build`'s — a rest parameter that is the empty tuple
   * only when there is nothing left unmet — except it excludes `Scope`
   * first: `Scope` is not a real dependency the caller must supply, it is
   * the phantom marker that routed the module here in the first place, and
   * this is the one entry point that discharges it (by actually opening a
   * `createScope`, unlike `build`, which never sees a resourceful module at
   * all — `Scope` in `Needs` makes that a compile error). Any *other*
   * unmet requirement in `N` still has to surface, so `Exclude<N, Scope>`,
   * not a blanket bypass, is what the rest parameter is computed from.
   */
  scoped: <X, E, N, A, E2>(
    module: Module<X, E, N>,
    use: (ctx: Context<X>) => AsyncResult<A, E2>,
    options?: ScopedOptions,
    ..._missing: [Exclude<N, Scope>] extends [never]
      ? []
      : [error: "UNSATISFIED DEPENDENCIES", missing: Exclude<N, Scope>]
  ): AsyncResult<A, E | E2> => runScoped(module as never, use as never, options) as never,

  /**
   * A short-lived scope layered over an already-built parent `Context`,
   * for per-request services (a transaction, a request id) that must not
   * outlive the request but do need to read services the parent already
   * constructed (a pool, config). Built from the exact same `runScoped`
   * `Module.scoped` uses above — Task 6 gave `runScoped` a `seed` parameter
   * precisely so this did not need any new machinery — just seeded with
   * `parent` instead of `Context.empty()` and handed a *fresh* `createScope`
   * (that happens inside `runScoped` itself).
   *
   * That fresh scope is exactly what makes the two load-bearing guarantees
   * hold: the parent's own services were never passed through `run` here
   * (only `module`'s providers are `flatten`ed and constructed against this
   * call), so none of the parent's finalisers are registered on this
   * scope — closing it therefore releases only what *this* fork acquired,
   * and the parent stays up for a second, sibling fork or for whatever the
   * enclosing `Module.scoped` does after this call returns.
   *
   * The gate is `scoped`'s, with one more exclusion: `Exclude<N, PParent |
   * Scope>` rather than `Exclude<N, Scope>`. `PParent` — the parent
   * `Context`'s own channel — is subtracted because a request module is
   * allowed to depend on anything the parent already provides (that is the
   * entire point of forking over a *built* parent instead of an empty one);
   * only a need that neither the request module itself nor the parent
   * satisfies must surface as the "UNSATISFIED DEPENDENCIES" arity error,
   * exactly as `NeedsMissing` does in `fork.test-d.ts`.
   */
  forkScope: <PParent, X, E, N, A, E2>(
    parent: Context<PParent>,
    module: Module<X, E, N>,
    use: (ctx: Context<PParent | X>) => AsyncResult<A, E2>,
    options?: ScopedOptions,
    ..._missing: [Exclude<N, PParent | Scope>] extends [never]
      ? []
      : [error: "UNSATISFIED DEPENDENCIES", missing: Exclude<N, PParent | Scope>]
  ): AsyncResult<A, E | E2> =>
    runScoped(module as never, use as never, options, parent as never) as never,
});
