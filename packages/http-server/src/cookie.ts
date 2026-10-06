import type { IncomingMessage } from "node:http";

import { Port, Provider, type AnyProvider } from "@btravstack/di";

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

/**
 * One member per composed scheme, `true` when that scheme reads a cookie — the
 * graph fact `csrf`'s default is computed from. `httpServer` contributes the
 * `false` member that keeps the set from being the empty dependency di refuses,
 * so a graph composing no scheme at all still starts.
 *
 * A set port rather than a marker `HttpModule` folds: `http()` never sees an
 * application's authenticators — the root composes them itself — so a signal
 * read off the options record would leave that surface silently unprotected.
 * A `ctx.get` at start could not answer it either: di's `Context` has no `has`.
 *
 * A member is owed by anything that READS OR WRITES a cookie, which is wider
 * than "an authenticator": `oidc()` is not a scheme and contributes one.
 */
export class CookieSchemes extends Port.many("HttpCookieSchemes")<boolean> {}

/**
 * What every cookie surface contributes — `defineHttp` for a scheme whose
 * description says it reads one, and `oidc()` for itself, which is not a scheme
 * at all but reads `__Host-oidc` and serves a state-changing `POST /logout`.
 *
 * "Whatever touches a cookie contributes" is the rule, not "whatever
 * authenticates": the narrower reading left a root composing `oidc()` and
 * `sessionCodec()` without `sessionAuthenticator` serving that logout with CSRF
 * off.
 */
export const cookieScheme = (): AnyProvider =>
  Provider.member(CookieSchemes)({ inject: {}, value: true });

/** `csrf` unset is on exactly when a composed surface reads a cookie. */
export const csrfOn = (option: boolean | undefined, schemes: readonly boolean[]): boolean =>
  option ?? schemes.some(Boolean);

/** The methods a browser can be made to send cross-site carrying ambient credentials. */
const STATE_CHANGING: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether a state-changing request carrying cookies came from another site.
 *
 * The rule is "a request that carries COOKIES must be same-site", not "a
 * request carrying our session cookie": the runtime does not know the scheme's
 * cookie name, and a check independent of that configuration is both the
 * standard fetch-metadata recommendation and the one a second cookie-reading
 * scheme cannot silently widen. A request with no cookie is left alone — a
 * caller presenting a header credential rides no ambient authority.
 *
 * Fetch metadata first, `Origin` only when the browser sent none. The `Origin`
 * comparison is HOST against the request's own `Host`, deliberately not scheme:
 * behind a TLS-terminating proxy the connection this process accepted is
 * `http` while the browser's `Origin` says `https`, so a scheme comparison
 * would refuse every real deployment. `__Host-session` is `Secure`, which is
 * what keeps the cookie off the plaintext scheme instead.
 */
export const crossSite = (request: IncomingMessage): boolean => {
  if (!STATE_CHANGING.has(request.method ?? "")) return false;
  if (request.headers.cookie === undefined) return false;
  const site = request.headers["sec-fetch-site"];
  if (typeof site === "string") {
    const value = site.toLowerCase();
    return value !== "same-origin" && value !== "same-site";
  }
  // No metadata and no `Origin` is refused rather than waved through: the
  // request carries a cookie, so something is presenting ambient authority
  // with nothing at all saying where from.
  // `Origin: null` — a sandboxed frame, a cross-origin redirect — and a
  // malformed value both fail to parse, and neither is the request's own host.
  const origin = URL.parse(request.headers.origin ?? "")?.host;
  return origin === undefined || origin !== request.headers.host;
};
