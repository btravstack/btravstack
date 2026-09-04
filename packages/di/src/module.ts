import type { AsyncResult } from "unthrown";

import { run, runScoped, type ScopedOptions, type SeedEntry } from "./build.js";
import { type Context } from "./context.js";
import type { AnyPort, Scope } from "./port.js";
import type { Provider } from "./provider.js";
import { createScope } from "./scope.js";

/**
 * Structural, listing only the concrete fields: a bound that compared the
 * phantom channels would trip on their mixed variance. Do not replace with
 * `Provider<any, any, any>`.
 */
export type AnyProvider = { readonly port: AnyPort; readonly deps: readonly AnyPort[] };

export type AnyModule = {
  readonly name: string;
  readonly imports: readonly AnyModule[];
  readonly provides: readonly AnyProvider[];
  readonly exports: readonly (AnyPort | AnyModule)[];
};

/**
 * All three positions are inferred at once and read positionally. Fixing the
 * other two to `unknown` makes the `extends` check fail against a contravariant
 * field, and every real provider falls through to `never`.
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
 * The variance rule, shared with `Provider`: capability channels (`_exports`)
 * are contravariant, so you may forget what you have; obligation channels
 * (`_error`, `_needs`) are covariant, so you may not forget what you owe.
 *
 * Both directions are load-bearing and were measured. Turning `_error` or
 * `_needs` contravariant lets an error channel narrow to one arm and lets
 * `Module<X, E, Database>` launder past the build gate as `Module<X, E,
 * never>`.
 */
export type Module<Exports, E, Needs> = {
  readonly _exports: (x: Exports) => void;
  readonly _error: () => E;
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
 * The provider arm is for the helpers that mint their own port and hand back
 * no class to name.
 *
 * Each arm must stay a plain union member, never a generic helper taking
 * `AnyPort`: instantiating the per-element conditional with the whole union
 * asks whether EVERY port is available, and rejects legal exports.
 */
export type Exportable<I extends readonly AnyModule[], P extends readonly AnyProvider[]> =
  | (AnyPort & (new () => Available<I, P>))
  | (AnyProvider & { readonly port: AnyPort & (new () => Available<I, P>) })
  | I[number];

type ResolvedExports<X extends readonly unknown[]> =
  | (X[number] extends infer E
      ? E extends AnyPort
        ? InstanceType<E>
        : E extends AnyProvider
          ? InstanceType<E["port"]>
          : never
      : never)
  | ExportsOfModule<Extract<X[number], AnyModule>>;

/**
 * The declaration gate. A port **this module's own providers** read, and that
 * nothing here satisfies, is an error unless it is named in `needs` — so a
 * provider can never silently receive a service from whoever composed the
 * module. Named, it may: the provider is handed whatever an ancestor supplies.
 * What naming does not do is make the port `Available` here, so a declared
 * need is still not exportable.
 *
 * An import's own unmet needs are not this module's to re-declare; `Scope` is
 * exempt, since nothing can provide it.
 *
 * The gate is an object with one required property, not `StartGate`'s bare
 * string: only the property makes the diagnostic name the port. Do not
 * "simplify" it back.
 */
export type NeedsGate<
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  N extends readonly AnyPort[],
> = [Exclude<NeedOf<P[number]>, Available<I, P>>] extends [InstanceType<N[number]> | Scope]
  ? unknown
  : {
      // Inline, never a named alias: an alias prints unreduced and the reader
      // gets their own tuples back instead of the port.
      readonly "UNDECLARED NEEDS — name it in `needs`": Exclude<
        Exclude<NeedOf<P[number]>, Available<I, P>>,
        InstanceType<N[number]> | Scope
      >;
    };

/**
 * Unexported, so `Module.build` and friends have a value to `Object.assign`
 * onto that keeps its generic call signature. `Module` below is the public
 * entry point.
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
    // Inline, never a named alias: declaration emit keeps an alias unreduced,
    // and the unreduced form names the imports' internal ports — TS2883/TS4023
    // on the first consumer that exports a composition root.
  ): Module<
    ResolvedExports<X>,
    ErrOf<P[number]> | ErrOfModule<I[number]>,
    Exclude<NeedOf<P[number]> | NeedsOfModule<I[number]>, Available<I, P>>
  > =>
    ({
      name,
      imports: options.imports ?? [],
      provides: options.provides ?? [],
      exports: (options.exports ?? []).map((entry) => ("port" in entry ? entry.port : entry)),
    }) as never;
}

/**
 * The entry points' gate for unmet dependencies, on `NeedsGate`'s mechanism:
 * `unknown` when nothing is unmet, the one-property object otherwise, so the
 * diagnostic ends on the missing port.
 */
export type DependencyGate<N> = [N] extends [never]
  ? unknown
  : { readonly "UNSATISFIED DEPENDENCIES — nothing provides": N };

/**
 * `Module.build` sorts the tree into dependency-ordered levels, checks for
 * wiring bugs before any factory runs, then constructs level by level.
 */
export const Module = Object.assign(ModuleDeclaration, {
  build: <X, E, N>(module: Module<X, E, N> & DependencyGate<N>): AsyncResult<Context<X>, E> =>
    run(module as never, createScope()) as never,

  /**
   * `Module.build`'s resourceful counterpart: opens a scope, runs the module,
   * hands the built `Context` to `use`, and closes the scope — releasing every
   * acquired resource, LIFO — on every path out.
   *
   * The gate excludes `Scope` alone, since this is the entry point that
   * discharges it; every other unmet requirement still surfaces.
   */
  scoped: <X, E, N, A, E2>(
    module: Module<X, E, N> & DependencyGate<Exclude<N, Scope>>,
    use: (ctx: Context<X>) => AsyncResult<A, E2>,
    options?: ScopedOptions,
  ): AsyncResult<A, E | E2> => runScoped(module as never, use as never, options) as never,

  /**
   * A short-lived scope layered over an already-built parent `Context`, for
   * per-request services that must not outlive the request but do read what
   * the parent constructed.
   *
   * The fork gets a fresh scope, so closing it releases only what the fork
   * acquired and the parent stays up for a sibling. The gate subtracts
   * `PParent` as well as `Scope`: a request module may depend on anything the
   * parent already provides. It also subtracts `InstanceType<Seeded>`, for the
   * same reason: a `seed` entry supplies a port from outside the tree exactly
   * as the parent does.
   */
  forkScope: <PParent, X, E, N, A, E2, Seeded extends AnyPort = never>(
    parent: Context<PParent>,
    module: Module<X, E, N> & DependencyGate<Exclude<N, PParent | InstanceType<Seeded> | Scope>>,
    use: (ctx: Context<PParent | X | InstanceType<Seeded>>) => AsyncResult<A, E2>,
    options?: Omit<ScopedOptions, "seed"> & { readonly seed?: readonly SeedEntry<Seeded>[] },
  ): AsyncResult<A, E | E2> =>
    runScoped(module as never, use as never, options as ScopedOptions, parent as never) as never,
});
