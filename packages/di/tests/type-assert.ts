/**
 * Exact type equality — the standard two-conditional trick. Distinguishes
 * "assignable both ways" from "literally the same type," which is what an
 * inference-pinning test needs and an ordinary assignability assertion
 * cannot give: assigning a value into a variable of a declared type checks
 * each field's type according to its own variance, so a phantom field
 * declared in contravariant position — e.g. `Provider`'s
 * `readonly _error: (e: E) => void` — only proves the declared type is
 * assignable *into* whatever the value actually carries. A narrower or
 * unrelated declared type (`never`, or a type that happens to be a subtype
 * of the real one) can pass that check even when the real inferred type has
 * silently widened, because a "smaller" target is always assignable into a
 * contravariant parameter position. `Equal` sidesteps this by comparing how
 * `A` and `B` each distribute a fresh type variable through a conditional —
 * the two only produce the same (non-generic) result when `A` and `B` are
 * the same type, regardless of where either type appears structurally.
 *
 * Shared across this package's `*.test-d.ts` files rather than duplicated
 * per file. Not exported from the package index — this is a test-only
 * helper, imported directly where needed.
 */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
