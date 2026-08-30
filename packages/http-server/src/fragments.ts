import type { ConfigSchema } from "@btravstack/config";

/**
 * One route a fragment answers. `path` carries `:name` segments, which
 * {@link ParamsOf} extracts at the type level and {@link matchPath} binds at
 * run time; `input` is any Standard Schema over the decoded form body, exactly
 * as `Config.provider` accepts one, so no schema library joins this package.
 */
export type FragmentRoute = {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly input?: ConfigSchema<Readonly<Record<string, string>>, unknown>;
};

/** A flat record of routes — the key space a piece names, as every worker's is. */
export type FragmentsContract = Readonly<Record<string, FragmentRoute>>;

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
export const defineFragments = <const F extends FragmentsContract>(fragments: F): F => fragments;

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
