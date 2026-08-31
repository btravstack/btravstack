import type { ConfigSchema } from "@btravstack/config";

/** The schema a `POST` route may validate its decoded form body against. */
export type FragmentInputSchema = ConfigSchema<Readonly<Record<string, string>>, unknown>;

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
