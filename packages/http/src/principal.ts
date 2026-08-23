import type { Requirements } from "@btravstack/contract";

// Mapped over the tuple, then indexed — NOT `keyof R[number]`, which is the
// INTERSECTION of each requirement's keys and so collapses to `never` the
// moment two requirements name different schemes. That is the multi-scheme
// case this type exists for, and it failed silently (measured).
export type SchemesOf<R extends Requirements> = { [I in keyof R]: keyof R[I] & string }[number];

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
export type Tagged<S extends keyof Schemes & string, Schemes> = S extends S
  ? { readonly scheme: S; readonly identity: Schemes[S] }
  : never;

/**
 * What a leaf's handler reads. Bare when its requirements name one scheme —
 * byte-for-byte what applications write today, so the common case pays nothing
 * for the feature — and a discriminated union when they name several.
 */
export type Principal<S extends string, Schemes> = [S] extends [never]
  ? never
  : [S] extends [keyof Schemes]
    ? IsUnion<S> extends true
      ? Tagged<S & keyof Schemes, Schemes>
      : Schemes[S & keyof Schemes]
    : never;
