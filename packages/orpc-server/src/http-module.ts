import { Env, type ConfigInvalid } from "@btravstack/config";
import type { Observers } from "@btravstack/core";
import {
  Module,
  type AnyModule,
  type AnyPort,
  type AnyProvider,
  type Exportable,
  type NeedsGate,
  type PortInstance,
  type Provider,
} from "@btravstack/di";
import type { HtmxFragmentsPort } from "@btravstack/htmx-server/internal";
import { htmx } from "@btravstack/htmx-server/internal";
import { HttpHandler, HttpRuntime, httpServer, type HttpConfig } from "@btravstack/http-server";
import type { CookieSchemes } from "@btravstack/http-server/internal";
import {
  type AnyUnitModule,
  type HttpServerEnv,
  type HttpUnit,
  type UnitsNeedsOf,
} from "@btravstack/http-server/internal";

import type { OrpcHttpOptions } from "./http.js";
import { orpc, type OrpcRouterPort } from "./orpc.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type HttpStarter<Units> = Module<
  HttpRuntime | HttpConfig | HttpHandler | HttpUnit | CookieSchemes | Observers,
  ConfigInvalid,
  HttpServerEnv | UnitsNeedsOf<Units>
>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[], Units> = readonly [...I, HttpStarter<Units>];

/** Whatever `api.OrpcRouter(contract)(…)` returns. */
type AnyRouterProvider = Provider<OrpcRouterPort, unknown, unknown> & {
  readonly authenticators: readonly AnyProvider[];
  readonly pieces: readonly AnyProvider[];
};

/** Whatever `api.HtmxFragments([…])` returns. */
type AnyFragmentsProvider = Provider<HtmxFragmentsPort, unknown, unknown> & {
  readonly authenticators: readonly AnyProvider[];
  readonly pieces: readonly AnyProvider[];
};

/** The scheme authenticators a supplied provider carries, or `never` when none was supplied. */
type AuthOf<T> = T extends { readonly authenticators: readonly (infer A)[] } ? A : never;

/** What the imports export. */
type ExportsOf<I extends readonly AnyModule[]> = I[number] extends infer M
  ? M extends Module<infer X, unknown, unknown>
    ? X
    : never
  : never;

/** `Piece`, unless an import already exports its port — a slice providing its own. */
type Unexported<Piece, Exports> = Piece extends { readonly port: infer Port extends AnyPort }
  ? [InstanceType<Port>] extends [Exports]
    ? never
    : Piece
  : never;

/** The pieces a supplied provider composes that no import exports, or `never`. */
type PiecesOf<T, I extends readonly AnyModule[]> = T extends {
  readonly pieces: readonly (infer Piece)[];
}
  ? Unexported<Piece, ExportsOf<I>>
  : never;

/** The `orpc()`/`htmx()` answerer this root composes when the matching option is supplied. */
type OrpcAnswerer = ReturnType<typeof orpc>;
type HtmxAnswerer = ReturnType<typeof htmx>;

/**
 * What this root provides: the router and its own `orpc()` answerer when
 * `router` is supplied, the fragments provider and its own `htmx()` answerer
 * when `fragments` is, each provider's scheme authenticators, the pieces each
 * composes that no import exports, and the application's own. `Router`/`Fragments` resolve to `undefined` — every
 * branch gated on them collapsing to `never` — when the matching option is
 * omitted, which is what lets `HttpModule` compose a router, fragments, or
 * both from one declaration. A union-element array rather than a tuple:
 * each authenticator union is one type per scheme, and a tuple takes one
 * rest element, not two.
 */
type Provides<
  P extends readonly AnyProvider[],
  Router,
  Fragments,
  I extends readonly AnyModule[],
> = readonly (
  | ([Router] extends [undefined] ? never : Exclude<Router, undefined> | OrpcAnswerer)
  | ([Fragments] extends [undefined] ? never : Exclude<Fragments, undefined> | HtmxAnswerer)
  | AuthOf<Router>
  | AuthOf<Fragments>
  | PiecesOf<Router, I>
  | PiecesOf<Fragments, I>
  | P[number]
)[];

/**
 * The kinds `units<…>()` declared, read back off one answerer's `_units`
 * phantom. A provider carrying no such property infers `unknown`, an answerer
 * `units` was never called on carries the empty record, and an omitted option
 * is `undefined` — all three give no keys, which is what the gate below reads
 * as "this api declared none".
 */
type UnitsOfAnswerer<T> = T extends { readonly _units?: infer U } ? U : Record<never, never>;

/**
 * The kinds this root's answerers declare. An intersection, not a preference:
 * an answerer that declared none contributes no keys, and a router and a
 * fragments provider from two different apis must satisfy BOTH declarations.
 */
type DeclaredUnits<Router, Fragments> = UnitsOfAnswerer<Router> & UnitsOfAnswerer<Fragments>;

/**
 * Every scheme a supplied answerer serves. Recovered from its needs channel
 * rather than from a phantom of its own: a router already owes one
 * `HttpAuthenticator:${scheme}` port per scheme its contract marks, and a
 * fragments provider one per scheme its routes require, so the names are
 * already there to be read.
 */
type SchemesOfAnswerer<T> = T extends { readonly _needs: () => infer N }
  ? N extends PortInstance<`HttpAuthenticator:${infer S}`, unknown>
    ? S
    : never
  : never;

/**
 * The kinds this root may bind: the ones `units<…>()` declared when an answerer
 * carries them, else `anonymous` and every scheme the answerers serve. An
 * unbound scheme falls back to `anonymous` at runtime, so without this a
 * misspelled kind would fork `anonymous` for every request and diagnose
 * nothing.
 */
type BindableKinds<Router, Fragments> = [keyof DeclaredUnits<Router, Fragments>] extends [never]
  ? ServedKinds<Router, Fragments>
  : keyof DeclaredUnits<Router, Fragments>;

/** `anonymous` and every scheme the answerers serve — the kinds a root may name. */
type ServedKinds<Router, Fragments> =
  | "anonymous"
  | SchemesOfAnswerer<Router>
  | SchemesOfAnswerer<Fragments>;

/**
 * The kinds a request to one answerer opens under, off its `_kinds` phantom —
 * the EFFECTIVE marks, not the needs channel, which keeps shadowed ones. A
 * provider carrying no phantom is read as public plus every scheme it owes,
 * the conservative reading; an omitted answerer opens none.
 */
type KindsOf<T> = [T] extends [undefined]
  ? never
  : T extends { readonly _kinds?: infer P }
    ? string extends P
      ? "anonymous" | SchemesOfAnswerer<T>
      : P
    : "anonymous" | SchemesOfAnswerer<T>;

/**
 * The kinds a request to THIS root really forks under: the answerers' own,
 * and `anonymous` too when one of their schemes declared no module and falls
 * back to it — the runtime's `units[kind] ?? units.anonymous`.
 */
type ReachableKinds<Router, Fragments> =
  | KindsOf<Router>
  | KindsOf<Fragments>
  | ([
      Exclude<
        KindsOf<Router> | KindsOf<Fragments>,
        "anonymous" | keyof DeclaredUnits<Router, Fragments>
      >,
    ] extends [never]
      ? never
      : "anonymous");

/**
 * The declared kinds a request to THIS root can open under, which the root must
 * bind: a leaf under one is typed by the module `units<…>()` named, and left
 * unbound it would fork `anonymous`'s — or nothing — at runtime. A declared
 * kind no request here forks under stays optional, `anonymous` included when
 * every leaf is authenticated.
 */
type RequiredKinds<Router, Fragments> = keyof DeclaredUnits<Router, Fragments> &
  ReachableKinds<Router, Fragments>;

/**
 * A bound kind no request can ever open under. A record whose keys are not
 * literal — one built by `Object.fromEntries` — carries no name to check, so it
 * is passed rather than refused for having a `string` key outside the set.
 */
type UndeclaredKind<Units, Router, Fragments> = string extends keyof Units
  ? never
  : Exclude<keyof Units, BindableKinds<Router, Fragments>>;

/**
 * The `unit` gate, riding an intersection on the option so `Units` still infers
 * from the value. An undeclared kind is refused against a marker — an
 * excess-property check cannot see one, since the key is part of the very type
 * it inferred. A declared kind bound to the wrong module is refused by ordinary
 * assignability against the module type `units<…>()` named, which is the
 * diagnostic worth having — and so is a required kind left unbound, which is
 * TypeScript's own `Property 'user' is missing`.
 */
type UnitGate<Units, Router, Fragments> = [UndeclaredKind<Units, Router, Fragments>] extends [never]
  ? {
      readonly [
        K in
          | (keyof Units & keyof DeclaredUnits<Router, Fragments>)
          | RequiredKinds<Router, Fragments>
      ]: DeclaredUnits<Router, Fragments>[K];
    }
  : {
      readonly "UNDECLARED UNIT KIND — no request opens under it, so it would silently fall back to anonymous": UndeclaredKind<
        Units,
        Router,
        Fragments
      >;
    };

/**
 * The "serves nothing" gate: `unknown` once at least one of `router` /
 * `fragments` is supplied, an object with one required property when
 * neither is — `NeedsGate`'s own construction, so a root declaring no
 * answerer at all is refused at the call rather than booting a listener with
 * nothing behind it.
 */
type ServesNothingGate<Router, Fragments> = [Router] extends [undefined]
  ? [Fragments] extends [undefined]
    ? { readonly "SERVES NOTHING — supply a router, fragments, or both": true }
    : unknown
  : unknown;

/**
 * The kinds one answerer's `units<…>()` declared and the other's did not, when
 * both declared some. No binding serves both: the answerer missing a kind types
 * its leaves under it against `anonymous`'s module, while the root binding the
 * kind for the other forks that module under them too.
 */
type DivergentKinds<Router, Fragments> = [keyof UnitsOfAnswerer<Router>] extends [never]
  ? never
  : [keyof UnitsOfAnswerer<Fragments>] extends [never]
    ? never
    :
        | Exclude<keyof UnitsOfAnswerer<Router>, keyof UnitsOfAnswerer<Fragments>>
        | Exclude<keyof UnitsOfAnswerer<Fragments>, keyof UnitsOfAnswerer<Router>>;

type DivergentGate<Router, Fragments> = [DivergentKinds<Router, Fragments>] extends [never]
  ? unknown
  : {
      readonly "DIVERGENT UNIT KINDS — the router and the fragments come from units<…>() calls declaring different kinds, so mint both from one": DivergentKinds<
        Router,
        Fragments
      >;
    };

/**
 * An answerer from `units<…>()` makes `unit` required once it serves a kind
 * that call declared: with no record bound, every leaf typed by that kind's
 * module would fork nothing at runtime. A marker rather than a required `unit`
 * property, which would collide with the option's own optional one and reduce
 * the whole parameter to `never`.
 */
type UnboundGate<Units, Router, Fragments> = [Units] extends [undefined]
  ? [RequiredKinds<Router, Fragments>] extends [never]
    ? unknown
    : {
        readonly "UNBOUND UNIT KINDS — units<…>() declared them, so bind each on unit": RequiredKinds<
          Router,
          Fragments
        >;
      }
  : unknown;

export type HttpModuleOptions<
  Router extends AnyRouterProvider | undefined,
  Fragments extends AnyFragmentsProvider | undefined,
  Units extends Readonly<Record<string, AnyUnitModule>> | undefined,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<Imports<I, Units>, Provides<P, Router, Fragments, I>>[],
  N extends readonly AnyPort[],
> = Omit<OrpcHttpOptions, "unit"> & {
  /**
   * The unit module each KIND binds — `anonymous` for a request no leaf asked
   * to authenticate, else the scheme that resolved the caller. Every bound
   * module's own unmet needs join this root's, less the principal the fork
   * seeds: a composition that binds one owes the composition root the same way
   * any other `needs` does.
   *
   * The kinds are gated against the answerers: the ones `units<…>()` declared,
   * carried by the router or the fragments alike, or — for a plain
   * `defineHttp()` api — `anonymous` and every scheme the answerers serve.
   * Under `units<…>()`, every declared kind the answerers serve must be bound.
   */
  readonly unit?: Units & UnitGate<Units, Router, Fragments>;
  /**
   * The application's oRPC router — what `api.OrpcRouter(contract)(…)` returns.
   * It carries the scheme authenticators `defineHttp` bound, which is how they
   * reach `provides` without an application listing them. Optional: a root may
   * serve `fragments` alone.
   */
  readonly router?: Router;
  /**
   * The application's htmx fragments — what `api.HtmxFragments([…])`
   * returns. Carries its own scheme authenticators the same way `router` does.
   * Optional: a root may serve `router` alone. An authenticator provider the
   * two share is deduplicated by reference before it reaches `provides`, so
   * this module's own array is correct on its own terms rather than relying
   * on di's internal module-tree flattening to absorb the duplicate.
   */
  readonly fragments?: Fragments;
  /**
   * Where htmx fragments are mounted, default `/` — `htmx()`'s own default.
   * `prefix` (above, from `HttpOptions`) stays the oRPC mount, default `/rpc`:
   * one field cannot carry two independent mount points with two different
   * defaults, so a root serving both protocols gets this second,
   * differently-named option instead of overloading the first.
   */
  readonly fragmentsPrefix?: `/${string}`;
  /**
   * `htmx()`'s `login` — the login route an unauthenticated fragment caller is
   * sent to. Named for the fragment half like `fragmentsPrefix` is, and for the
   * same reason: it is the htmx answerer's alone, and a bare `login` here would
   * read as covering the oRPC half, which refuses a caller with `UNAUTHORIZED`
   * and redirects nothing.
   */
  readonly fragmentsLogin?: `/${string}`;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `HttpRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
  /**
   * What this root's OWN providers expect from outside. di's gate is re-stated
   * over the augmented tuples below, so forgetting one is an error at THIS call.
   *
   * `Env` is added to what this gate counts as declared, so a root composing a
   * scheme that configures itself from the environment never restates it — the
   * same hiding the starter this sugar imports already gets, since it needs
   * `Env` too and no root has ever named that either.
   */
  readonly needs?: N;
} & NeedsGate<Imports<I, Units>, Provides<P, Router, Fragments, I>, EnvAnd<N>> &
  ServesNothingGate<Router, Fragments> &
  UnboundGate<Units, Router, Fragments> &
  DivergentGate<Router, Fragments>;

/**
 * The declared needs plus `Env`. di's `needs` array is type-level only —
 * `Module` drops it at runtime and computes the module's needs channel from the
 * providers — and its gate only asks that the unmet set be a SUBSET of the
 * declared one, so adding a port nothing needs costs nothing.
 */
type EnvAnd<N extends readonly AnyPort[]> = readonly [...N, typeof Env];

/**
 * `Module(name)({...})` for an HTTP deployment: everything a di module takes,
 * plus a router, fragments, or both. The sugar imports the socket half
 * (`httpServer`), provides whichever answerer(s) the options name and exports
 * `HttpRuntime`, handing back exactly the module `Module(...)` would have
 * declared over the augmented tuples.
 *
 * ```ts
 * export const OrderApi = HttpModule("OrderApi")({
 *   router: orderRouter,
 *   imports: [OrderApplicationModule, OrderPersistenceModule],
 *   exports: [Logger],
 * });
 * await runMain(OrderApi);
 * ```
 *
 * A fragments-only root drops `router` and supplies `fragments` instead; a
 * root serving both supplies both, and `prefix`/`fragmentsPrefix` mount them
 * independently. Supplying neither is refused at this call.
 */
export const HttpModule =
  <const Name extends string>(name: Name) =>
  <
    Router extends AnyRouterProvider | undefined = undefined,
    Fragments extends AnyFragmentsProvider | undefined = undefined,
    Units extends Readonly<Record<string, AnyUnitModule>> | undefined = undefined,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<Imports<I, Units>, Provides<P, Router, Fragments, I>>[] =
      [],
    const N extends readonly AnyPort[] = [],
  >(
    options: HttpModuleOptions<Router, Fragments, Units, I, P, X, N>,
  ) => {
    const { router, fragments } = options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    // The whole options record, not a field-by-field spread: every option
    // `httpServer` reads is forwarded by construction, since `HttpModuleOptions`
    // IS `HttpOptions` plus the module lists — the drift this file shipped
    // once. It guarantees nothing about the RENAMED options below, which are
    // spelled field by field into `htmx()` and are exactly where
    // `fragmentsLogin` was forgotten: a field this sugar names differently from
    // the answerer it feeds has to be written down twice, and the second
    // writing is the one that can be missed. The lists
    // `httpServer`/`orpc`/`htmx` do not know are ignored rather than rejected,
    // a rest destructuring being what `exactOptionalPropertyTypes` cannot type
    // here (`Omit` over the deferred `NeedsGate` intersection drops the
    // modifiers).
    const starter = httpServer(options);
    // Keyed by reference, the same technique di's own module-tree flattening
    // uses: the SAME authenticator provider named by both `router` and
    // `fragments` lands in `provides` once, so this array is correct on its
    // own terms rather than by relying on di to absorb the duplicate.
    const authenticators = [
      ...new Set([...(router?.authenticators ?? []), ...(fragments?.authenticators ?? [])]),
    ];
    // Every piece, including one a slice already provides: di keys providers
    // by reference, so the same piece seen twice is one provider.
    const pieces = [...(router?.pieces ?? []), ...(fragments?.pieces ?? [])];
    // The assertion is the gate, not the shape: `NeedsGate` defers while the
    // tuples are type parameters, and is computed at the application's own call
    // because `HttpModuleOptions` re-declares it. Spelled out rather than
    // `as never`, which collapses the return to `Module<never, never, never>`.
    return Module(name)({
      imports: [...imports, starter] as Imports<I, Units>,
      provides: [
        ...(router === undefined ? [] : [router, orpc(options)]),
        ...(fragments === undefined
          ? []
          : [fragments, htmx({ prefix: options.fragmentsPrefix, login: options.fragmentsLogin })]),
        ...authenticators,
        ...pieces,
        ...provides,
      ] as unknown as Provides<P, Router, Fragments, I>,
      // `HttpHandler` too, and not as a courtesy: the runtime RESOLVES it, so
      // `start`'s gate refuses a root that does not export it. A second
      // protocol's answerer lands in the same set from its own provider.
      exports: [HttpRuntime, HttpHandler, ...exports] as readonly [
        typeof HttpRuntime,
        typeof HttpHandler,
        ...X,
      ],
      needs: [...(options.needs ?? []), Env] as EnvAnd<N>,
    } as {
      readonly imports: Imports<I, Units>;
      readonly provides: Provides<P, Router, Fragments, I>;
      readonly exports: readonly [typeof HttpRuntime, typeof HttpHandler, ...X];
      readonly needs: EnvAnd<N>;
    } & NeedsGate<Imports<I, Units>, Provides<P, Router, Fragments, I>, EnvAnd<N>>);
  };
