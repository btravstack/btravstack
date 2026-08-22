import type { Requirements } from "@btravstack/contract";

/** Every scheme any of a leaf's requirements names. */
export type SchemesOf<R extends Requirements> = keyof R[number] & string;

// Distributes over `T`, then asks whether the whole union is assignable back
// into the one member being visited — false for a single member, true for a
// union. The standard test; do not "simplify" it to `T extends U`.
export type IsUnion<T, U = T> = [T] extends [never]
  ? false
  : T extends U
    ? [U] extends [T]
      ? false
      : true
    : never;

/** One arm per scheme, tagged by its name so a handler can switch on it. */
export type Tagged<S extends string, Schemes> = S extends S
  ? { readonly scheme: S; readonly identity: S extends keyof Schemes ? Schemes[S] : never }
  : never;

/**
 * What a leaf's handler reads. Bare when its requirements name one scheme —
 * byte-for-byte what applications write today, so the common case pays nothing
 * for the feature — and a discriminated union when they name several.
 */
export type Principal<S extends string, Schemes> = [S] extends [never]
  ? never
  : IsUnion<S> extends true
    ? Tagged<S, Schemes>
    : S extends keyof Schemes
      ? Schemes[S]
      : never;
