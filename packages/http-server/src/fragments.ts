import type { ConfigSchema } from "@btravstack/config";

/** The schema a `POST` route may validate its decoded form body against. */
export type FragmentInputSchema = ConfigSchema<Readonly<Record<string, string>>, unknown>;

/**
 * One route a fragment answers. `path` carries `:name` segments, which
 * {@link ParamsOf} extracts at the type level and {@link matchPath} binds at
 * run time; `input` is any Standard Schema over the decoded form body, exactly
 * as `Config.provider` accepts one, so no schema library joins this package.
 *
 * A single object type, `input` optional on BOTH methods, deliberately: a
 * discriminated union (`GET` without `input` at all, `POST` with it) was
 * tried, to refuse `input` on `GET` structurally — and it broke a different
 * compile-time guarantee, several generic layers away in
 * `htmx-controller.ts` (`fragments.test-d.ts`'s "refused direction" case: a
 * piece minted over a MARKED route stopped being refused where an UNMARKED
 * slot expected it — refused only for a route-level mark; a contract-level
 * mark is not refused today — isolated by reverting `FragmentRoute` alone
 * with every other change held). `NoGetInputGate`, below, refuses `input` on
 * `GET` at `defineFragments` instead, without touching `FragmentRoute`'s own
 * shape.
 */
export type FragmentRoute = {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly input?: FragmentInputSchema;
};

/** A flat record of routes — the key space a piece names, as every worker's is. */
export type FragmentsContract = Readonly<Record<string, FragmentRoute>>;

/** Every key of `F` whose route is `GET` and still declares `input`. */
type GetWithInput<F extends FragmentsContract> = {
  readonly [K in keyof F]: F[K] extends { readonly method: "GET"; readonly input: unknown }
    ? K
    : never;
}[keyof F];

/**
 * `defineFragments`'s own gate: `unknown` when no `GET` route in `F` declares
 * `input`, an object with one required property when one does — the same
 * shape `orpc.ts`'s `ScopeGate` rides on `routerFor`'s `contract` parameter,
 * for the same reason: the diagnostic ends on the offending key. `htmx.ts`'s
 * `respond` never reads a body for `GET`, so an `input` schema there would
 * type-check the handler's third parameter and hand it `{}` at runtime —
 * this is what refuses that at the declaration instead.
 */
type NoGetInputGate<F extends FragmentsContract> = [GetWithInput<F>] extends [never]
  ? unknown
  : { readonly "INPUT ON GET — a GET route has no body to validate": GetWithInput<F> };

/**
 * A fragment contract. Not an oRPC contract: a procedure answers a typed
 * envelope and a browser navigation is not an RPC call. It carries
 * `@btravstack/contract`'s `authenticated()` marker unchanged, which is what
 * gives a fragment route the same principal and the same 401/403 path as a
 * procedure.
 *
 * ```ts
 * export const fragments = authenticated({ user: [] })(
 *   defineFragments({
 *     orderRow: { method: "GET", path: "/orders/:id/row" },
 *   }),
 * );
 * ```
 */
export const defineFragments = <const F extends FragmentsContract>(
  fragments: F & NoGetInputGate<F>,
): F => fragments;

// Collects param names into a union first, rather than intersecting one
// `{ readonly [K in Name]: string }` per segment: intersecting the terminal
// segment's result with the empty-record case (`Record<never, never>`) is a
// type distinct from the bare object under this file's `Equal` type test,
// so `ParamsOf<"/orders/:id/row">` failed to match `{ readonly id: string }`
// until the names were unioned and mapped exactly once.
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/**
 * The parameters a path template names. `"/orders/:id/row"` is
 * `{ readonly id: string }`; a template naming none is an empty record.
 */
export type ParamsOf<P extends string> = { readonly [K in ParamNames<P>]: string };

// `decodeURIComponent` throws on a malformed sequence such as `%ZZ`, and the
// segment is client-controlled — a throw here would surface as a defect rather
// than a request that simply does not match.
const decode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

/**
 * The parameters `path` binds against `pattern`, or `undefined` when it does
 * not match. Segment counts must agree — a mount is a shape rather than a
 * prefix, so `/orders/42/row/extra` is not `/orders/:id/row`. A parameter
 * segment must also be non-empty and validly percent-encoded, so
 * `/orders/:id` declines both `/orders/` and `/orders/%ZZ` rather than
 * binding an empty or malformed value.
 */
export const matchPath = (
  pattern: string,
  path: string,
): Readonly<Record<string, string>> | undefined => {
  const expected = pattern.split("/");
  const actual = path.split("/");
  if (expected.length !== actual.length) return undefined;
  const bound: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] as string;
    if (segment.startsWith(":")) {
      if (value === "") return undefined;
      const decoded = decode(value);
      if (decoded === undefined) return undefined;
      bound[segment.slice(1)] = decoded;
      continue;
    }
    if (segment !== value) return undefined;
  }
  return bound;
};
