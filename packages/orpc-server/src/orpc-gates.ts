import type { IsMarked, PrincipalKey, RequirementsOf } from "@btravstack/contract";
import type { PortClassOf, PortInstance, Provider } from "@btravstack/di";
import type { IsUnion } from "@btravstack/http-server/internal";
import type { RequiresGate, SchemesIn } from "@btravstack/http-server/internal";
import type { ProcedureContract, RouterContract } from "@orpc/contract";
import type { Router } from "@orpc/server";

import type {
  CONTROLLER_PREFIX,
  ControllerKeyOf,
  ControllerPortOf,
  PathsOf,
} from "./controller.js";
export type { RequiresGate, SchemesIn } from "@btravstack/http-server/internal";

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

/**
 * The kinds a request to `C` opens under, read off each procedure's EFFECTIVE
 * requirement — nearest mark wins, as `routerOf` inherits it — so a mark every
 * child overrides contributes nothing: `"anonymous"` for a procedure with no
 * requirement, else the schemes it accepts. `AllRequirementsOf` keeps shadowed
 * marks on purpose, for the authenticators; this must not.
 */
export type KindsIn<C, R = never> =
  C extends ProcedureContract<infer _I, infer _O, infer _E>
    ? [IsMarked<C> extends true ? RequirementsOf<C> : R] extends [never]
      ? "anonymous"
      : SchemesIn<IsMarked<C> extends true ? RequirementsOf<C> : R>
    : {
        readonly [K in Exclude<keyof C, PrincipalKey>]: KindsIn<
          C[K],
          IsMarked<C> extends true ? RequirementsOf<C> : R
        >;
      }[Exclude<keyof C, PrincipalKey>];

/** What every `OrpcRouter` arm returns; only the needs channel `N` differs. */
export type Built<Auth, N, Units, Kinds = string> = Provider<
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
  /** Phantom: the kinds a request here opens under, read by `HttpModule`, never at runtime. */
  readonly _kinds?: Kinds;
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

/** What `routerFor` checks: `RequiresGate` over every requirement the contract carries. */
export type ScopeGate<C, Vocab> = RequiresGate<AllRequirementsOf<C>, Vocab>;
