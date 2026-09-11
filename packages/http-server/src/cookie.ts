/**
 * One cookie out of the `cookie` header, which `node:http` delivers as ONE
 * string. The name is matched EXACTLY, so `__Host-session-x` is not
 * `__Host-session`; only the first `=` splits, so a value carrying one arrives
 * whole; and the FIRST of a repeated name wins, which is the order a browser
 * sends them in — most specific first — so a later duplicate cannot shadow the
 * session.
 *
 * This file is deliberately NOT an entry point: `sessionAuthenticator` reads a
 * session with these and `oidc()` reads and writes its own transient, and a
 * second copy is how the two would drift on the next edge case.
 */
export const cookieValue = (header: string | undefined, name: string): string | undefined => {
  for (const part of header?.split(";") ?? []) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
};

/**
 * One `Set-Cookie`, on the attributes the `__Host-` prefix requires anyway —
 * `Secure`, `Path=/`, no `Domain` — plus `HttpOnly` and `SameSite=Lax`. `Lax`
 * rather than `Strict` because the OIDC callback is a top-level navigation
 * arriving from the provider, and `Strict` would strip the cookie off it.
 */
export const setCookie = (name: string, value: string, maxAgeSec: number): string =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;

/** Clearing is the same cookie with no value and no lifetime. */
export const clearCookie = (name: string): string => setCookie(name, "", 0);
