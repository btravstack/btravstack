/**
 * Where a browser may be sent back to: a path on THIS site, or `/`.
 *
 * One function, shared by `htmx()` — which MINTS the value from a refused
 * request's own target — and by `oidc()`, which seals one at `/login` and
 * follows it at the callback. It was written twice and is not any more: two
 * copies of this rule is one copy hardened against a new vector while the
 * other keeps accepting what the first now refuses.
 *
 * Two clauses. It must start with `/`, so nothing carrying a scheme survives.
 * And its SECOND character may be neither `/` nor `\`: `//evil.example` is
 * protocol-relative, and `new URL("/\\evil.com", base)` resolves to
 * `https://evil.com/` — the WHATWG parser reads `\` as `/` in relative-slash
 * state, so a route whose first segment is a parameter can mint one.
 *
 * **What a HEADER accepts is the header's business, not this function's.**
 * Node's validator is `/[^\t\x20-\x7e\x80-\xff]/`: it refuses control
 * characters AND every code point above U+00FF. A clause covering only the
 * first left `/订单/1` — an ordinary non-Latin-1 path, arriving through this
 * very seam — passing the guard and then `ERR_INVALID_CHAR`ing the response
 * with the caller's authorization code already spent. So every caller runs
 * `encodeURI` where the value becomes a `Location`, which closes both classes
 * at once and is shorter than the clause it replaced (measured: `/订单/1` →
 * `/%E8%AE%A2%E5%8D%95/1`; `/\nX` → `/%0AX`, unsplittable).
 *
 * The value must arrive DECODED ONCE — a query parser's own decode is that
 * one — and must never be decoded again: a second pass turns `%255C` back into
 * `\`, which is this guard walked past using its own output. `encodeURI`
 * re-encodes `%`, so a once-decoded value round-trips to exactly what it was.
 */
export const returnTo = (value: string | null | undefined): string =>
  typeof value === "string" && value.startsWith("/") && value[1] !== "/" && value[1] !== "\\"
    ? value
    : "/";
