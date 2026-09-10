// A control character in a `Location` is `ERR_INVALID_CHAR` from `writeHead`
// (measured against a live listener): Node blocks the header split itself, so
// the cost is a 500 — but on the OIDC callback that 500 has already spent the
// caller's authorization code.
const controlled = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * Where a browser may be sent back to: a path on THIS site, or `/`.
 *
 * One function, shared by `htmx()` — which MINTS the value from a refused
 * request's own target — and by `oidc()`, which seals one at `/login` and
 * follows it at the callback. It was written twice and is not any more: two
 * copies of this rule is one copy hardened against a new vector while the
 * other keeps accepting what the first now refuses.
 *
 * Three clauses, each measured. It must start with `/`, so nothing carrying a
 * scheme survives. Its SECOND character may be neither `/` nor `\`:
 * `//evil.example` is protocol-relative, and `new URL("/\\evil.com", base)`
 * resolves to `https://evil.com/` — the WHATWG parser reads `\` as `/` in
 * relative-slash state, so a route whose first segment is a parameter can mint
 * one. And it may carry no control character, per the comment above.
 *
 * The value must arrive DECODED ONCE — a query parser's own decode is that
 * one — and must never be decoded again: a second pass turns `%255C` back into
 * `\`, which is this guard walked past using its own output.
 */
export const returnTo = (value: string | null | undefined): string =>
  typeof value === "string" &&
  value.startsWith("/") &&
  value[1] !== "/" &&
  value[1] !== "\\" &&
  !controlled(value)
    ? value
    : "/";
