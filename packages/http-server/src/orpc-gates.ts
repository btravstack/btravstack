import type { PrincipalKey, Requirements, RequirementsOf } from "@btravstack/contract";
import type { PortClassOf, PortInstance, Provider } from "@btravstack/di";
import type { ProcedureContract, RouterContract } from "@orpc/contract";
import type { Router } from "@orpc/server";

import type {
  CONTROLLER_PREFIX,
  ControllerKeyOf,
  ControllerPortOf,
  PathsOf,
} from "./controller.js";
import type { IsUnion, SchemesOf } from "./principal.js";

/**
 * A refused array: as long as the array the caller wrote, its head the caller's
 * own elements — which match — and its LAST element the marker paired with what
 * is wrong.
 *
 * TypeScript compares two equal-length tuples element by element, so the extra
 * diagnostic it reports lands on the trailing element and carries both the
 * sentence and the offending key. A fixed two-element tuple named the key only
 * when the array happened to be two elements long; every other arity was a
 * length mismatch, and the developer diffed the contract against the array by
 * hand.
 */
export type Refuse<
  T extends readonly unknown[],
  Marker extends string,
  Detail,
> = T extends readonly [...infer Head, unknown]
  ? readonly [...Head, readonly [Marker, Detail]]
  : readonly [readonly [Marker, Detail]];

/** What every `OrpcRouter` arm returns; only the needs channel `N` differs. */
export type Built<Auth, N, Units> = Provider<
  PortInstance<"OrpcRouter", Router<Record<never, never>>>,
  never,
  N
> & {
  readonly port: PortClassOf<"OrpcRouter", Router<Record<never, never>>>;
  /**
   * The scheme authenticators `defineHttp` bound, carried on the router because
   * the router is what needs them: they discharge its scheme ports.
   */
  readonly authenticators: readonly Auth[];
  /** Phantom: the kinds bound at `units<…>()`, read by `HttpModule`, never at runtime. */
  readonly _units?: Units;
};

/**
 * One piece of the router — what `OrpcController(contract, key)(…)` returns, as
 * the composing form consumes it. The port stays spelled INLINE rather than as
 * `ControllerPortOf<C, K, Schemes>` — kept as a regression guard, not for a hole
 * open today. On #116's flat `ControllerKeyOf` the alias spelling let TypeScript's
 * alias-variance fast path skip the contravariant handler check, so a marked
 * piece slipped under the unmarked contract. On the current recursive-path
 * `ControllerKeyOf` both spellings refuse that direction (re-measured
 * 2026-08-25, TS 7.0.2, same version as #116). The fast path is a compiler
 * heuristic that has already changed behaviour across one key-shape refactor,
 * so a future one could reopen it with no test failing; the inline spelling
 * costs one type literal and closes that off. The gate itself is
 * `controller.test-d.ts`'s refused
 * `api.OrpcRouter(contract)([markedOrders, markedUsers])`.
 */
export type PieceOf<C extends Record<string, RouterContract>, Schemes> = {
  readonly [K in ControllerKeyOf<C>]: {
    readonly port: {
      readonly portId: `${typeof CONTROLLER_PREFIX}${K}`;
      new (): InstanceType<ControllerPortOf<C, K, Schemes>>;
    };
  };
}[ControllerKeyOf<C>];

/** The key a piece carries, read back off its port id. */
export type KeyOfPiece<P> = P extends {
  readonly port: { readonly portId: `${typeof CONTROLLER_PREFIX}${infer K}` };
}
  ? K
  : never;

/** Every path to a PROCEDURE — the leaves a cover must partition. */
export type LeafPathsOf<C> = PathsOf<C, never, false>;

/** Whether leaf `L` sits at, or under, piece path `P`. */
export type CoveredBy<L extends string, P extends string> = L extends P | `${P}.${string}`
  ? true
  : false;

/** The procedures no piece in the array covers. */
export type Uncovered<C, Paths extends string> =
  LeafPathsOf<C> extends infer L extends string
    ? L extends string
      ? true extends { [P in Paths]: CoveredBy<L, P> }[Paths]
        ? never
        : L
      : never
    : never;

/**
 * Top-level contract keys carrying a literal dot. A piece path is joined and
 * split on `.`, so such a key cannot be named — and unlike a dotted key deeper
 * in the tree, it has no nameable ancestor a piece could cover it from, the
 * array form being rooted at the contract itself. Reported ahead of `Uncovered`
 * because "no piece can name this" is a different fact from "no piece did".
 */
export type Unsliceable<C> = Extract<
  Exclude<keyof C, PrincipalKey> & string,
  `${string}.${string}`
>;

/**
 * Whether a piece in the array is not a piece at all.
 *
 * A minted piece carries exactly ONE key on its port id. When the mint itself
 * was refused — `OrpcController(contract, "billing")` on a contract with no
 * `billing` — TypeScript still hands back a value, typed from the parameter it
 * rejected, so the key reads as the whole union of valid paths. That union
 * contains a path and a path under it, which is precisely what `Overlapping`
 * exists to refuse, and the array call then reported OVERLAPPING at a call site
 * where nothing overlaps: the first error was right and the loudest one wrong.
 *
 * So a union-keyed element makes the array's own gates stand down. The program
 * does not compile either way — the mint's `TS2345`, which names every valid
 * path, is the diagnostic to read.
 */
export type Erroneous<T extends readonly unknown[]> = true extends {
  readonly [K in keyof T]: IsUnion<KeyOfPiece<T[K]>>;
}[number]
  ? true
  : false;

/**
 * A piece path nested inside another piece's path. Both would implement the
 * same procedures, and — unlike two pieces under ONE path, which are one port
 * id and therefore di's duplicate-provider defect — these are two distinct ids
 * di cannot see conflicting, so the `nest` rebuild would silently let one win.
 * This gate is the only thing standing between a dotted path and that.
 */
export type Overlapping<Paths extends string> = {
  [P in Paths]: Paths extends infer Q extends string
    ? Q extends string
      ? Q extends P
        ? never
        : P extends `${Q}.${string}`
          ? P
          : never
      : never
    : never;
}[Paths];

/**
 * Every requirement the contract carries, anywhere. Over-, never
 * under-approximating: a requirement a nearer mark shadows still contributes
 * its scheme, which costs a dep nothing uses rather than a missing one.
 */
export type AllRequirementsOf<C> =
  | RequirementsOf<C>
  | (C extends ProcedureContract<infer _I, infer _O, infer _E>
      ? never
      : {
          readonly [K in Exclude<keyof C, PrincipalKey>]: AllRequirementsOf<C[K]>;
        }[Exclude<keyof C, PrincipalKey>]);

/**
 * Distributes `SchemesOf` over a union of requirement tuples — the ones a
 * contract walk collected, or a route's own `requires`, which is already one.
 */
export type SchemesIn<R> = R extends Requirements ? SchemesOf<R> : never;

/** Every scope string `R` names for scheme `K`, across every requirement. */
export type ScopesIn<R, K extends string> = R extends Requirements
  ? {
      // `K extends keyof R[I]` first, never `R[I][K & keyof R[I]]`: indexing a
      // requirement that does not name `K` gives `never`, and inferring `S`
      // from `never` falls back to its constraint `string`, so every scope
      // looks grantable the moment two requirements name different schemes.
      [I in keyof R]: K extends keyof R[I]
        ? R[I][K] extends readonly (infer S extends string)[]
          ? S
          : never
        : never;
    }[number]
  : never;

/** A scope `R` names that its scheme's authenticator cannot grant. */
export type UngrantableIn<R, Vocab> = {
  // A scheme the registry does not know is di's to report, not this gate's:
  // treating it as an empty vocabulary turns a misspelled SCHEME into a scope
  // complaint, the wrong diagnostic and earlier than the right one.
  [K in SchemesIn<R>]: K extends keyof Vocab ? Exclude<ScopesIn<R, K>, Vocab[K]> : never;
}[SchemesIn<R>];

/**
 * The scope check over a requirements union. It rides an intersection on the
 * parameter it checks, and its failure branch is an object with one required
 * property, which is what makes the diagnostic name the offending scope.
 * Exported for `htmx-route.ts`, whose `requires` already IS such a union.
 */
export type RequiresGate<R, Vocab> = [UngrantableIn<R, Vocab>] extends [never]
  ? unknown
  : {
      readonly "UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it": UngrantableIn<
        R,
        Vocab
      >;
    };

/** What `routerFor` checks: `RequiresGate` over every requirement the contract carries. */
export type ScopeGate<C, Vocab> = RequiresGate<AllRequirementsOf<C>, Vocab>;
