import { z } from "zod";

/**
 * A whole number, read the way an environment variable actually arrives: as a
 * string.
 *
 * The non-empty string in front of the coercion is the load-bearing part.
 * Coercion is `Number()` underneath, and `Number("")` is `0` — so a bare
 * `PORT=` would bind the ephemeral port `0`, an endpoint nobody can find. The
 * bounds cannot catch it, because a port's `min` **is** `0`. An empty value is
 * a configuration error, not an absent one — `.default(...)` applies only when
 * the variable is genuinely missing.
 *
 * The `<string>` type argument is needed because `z.coerce.number()`'s input
 * is `unknown`, which `.pipe` will not accept from a `string`.
 */
export const wholeNumber = (fallback: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .pipe(z.coerce.number<string>().int().min(min).max(max))
    .default(fallback);

/** A port: a whole number in the range the OS will accept, `0` included. */
export const port = (fallback: number) => wholeNumber(fallback, 0, 65_535);
