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
 * {@link forLocation} where the value becomes a `Location`, which closes both
 * classes at once (measured: `/订单/1` → `/%E8%AE%A2%E5%8D%95/1`; `/\nX` →
 * `/%0AX`, unsplittable).
 *
 * **`forLocation`, and NOT `encodeURI`.** The value a browser sent is already
 * percent-encoded (`/orders/a%20b/row`), the seam decodes it exactly once on
 * the way back, and `encodeURI` would re-encode the `%` it finds:
 * `/orders/a%2520b/row`, a real user landing on a route whose parameter binds
 * to the literal `a%20b`. So the encoder leaves `%` exactly as it arrived and
 * touches only what a URI cannot carry.
 *
 * The value must arrive DECODED ONCE — a query parser's own decode is that
 * one — and must never be decoded again: a second pass turns `%255C` back into
 * `\`, which is this guard walked past using its own output.
 */
export const returnTo = (value: string | null | undefined): string =>
  typeof value === "string" && value.startsWith("/") && value[1] !== "/" && value[1] !== "\\"
    ? value
    : "/";

/**
 * A once-decoded path made fit for a `Location` header: every character a URI
 * cannot carry — a control character, a space, anything above ASCII — is
 * percent-encoded, and `%` is left exactly as it arrived, so a value the
 * browser already encoded is not encoded twice.
 */
export const forLocation = (path: string): string =>
  path.replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/gu, (character) =>
    encodeURIComponent(character),
  );
