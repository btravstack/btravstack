import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

import { Config, ConfigInvalid, Env } from "@btravstack/config";
import { Observers, observe, type Operation, type Settle } from "@btravstack/core";
import { Provider } from "@btravstack/di";
import {
  ClientSecretBasic,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  calculatePKCECodeChallenge,
  discovery,
  enableNonRepudiationChecks,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
  type IDToken,
} from "openid-client";
import { ErrAsync, TaggedError, fromPromise, type AsyncResult } from "unthrown";

import { clearCookie, cookieValue, setCookie } from "./cookie.js";
import { HttpHandler, type HttpAnswerer } from "./handler.js";
import { forLocation, returnTo } from "./redirect.js";
import {
  SESSION_COOKIE,
  SessionCodec,
  TRANSIENT_TTL_SEC,
  type SessionCodecService,
} from "./session.js";

/**
 * Discovery did not answer, at boot. `cause` is whatever `openid-client`
 * rejected with — a connection refused, a document that is not one, a 404 on
 * `.well-known` — kept whole rather than flattened to a message, since the
 * three read very differently to whoever is fixing the deployment.
 */
export class OidcUnreachable extends TaggedError("OidcUnreachable")<{
  readonly issuer: string;
  readonly cause: unknown;
}> {}

/**
 * The provider would not exchange the code. Never a returned error — the
 * caller gets a bare `401` — but the CAUSE the observer is handed, so a
 * rotated client secret and a dead token endpoint are told apart on the line
 * rather than guessed at. Module-private: it rides `Settled.cause`, which is
 * `unknown`, and nothing outside constructs one.
 */
class GrantFailed extends TaggedError("GrantFailed")<{
  /** `openid-client`'s own error name — `ResponseBodyError`, `TypeError`, … */
  readonly error: string;
  readonly cause: unknown;
}> {}

export type OidcOptions<P> = {
  /** Pins `HTTP_OIDC_ISSUER` — the provider, as its discovery document names itself. */
  readonly issuer?: string;
  /** Pins `HTTP_OIDC_CLIENT_ID`. */
  readonly clientId?: string;
  /** Pins `HTTP_OIDC_CLIENT_SECRET` — this is a confidential client. */
  readonly clientSecret?: string;
  /**
   * Pins `HTTP_OIDC_REDIRECT_URI` — the URI REGISTERED with the provider, which
   * is also what the code grant is checked against. It is never rebuilt from
   * the request's `Host`.
   */
  readonly redirectUri?: string;
  /** Where the three routes are mounted. Default `/auth`. */
  readonly prefix?: `/${string}`;
  /** What the authorization request asks for. Default `openid`. */
  readonly scope?: string;
  /**
   * What the ID token's claims make the caller — the same shape
   * `jwtAuthenticator` takes, so one function serves both. Answering
   * `undefined` refuses the login: the claim this application requires and the
   * standard does not, such as a tenant.
   */
  readonly principal: (claims: IDToken) => P | undefined;
  /**
   * Where a logout lands when the provider advertises no `end_session_endpoint`.
   * Default `/`.
   */
  readonly postLogout?: `/${string}`;
  /**
   * Talk to an `http:` issuer that is NOT on a loopback host. Default `false`,
   * and a `ConfigInvalid` at boot without it: the client secret, the code and
   * every token cross the wire in cleartext, and `allowInsecureRequests` turns
   * off the check that would have said so.
   *
   * An OPTION rather than a variable, on rule 6's own test: its silent change
   * is a security regression, which is the argument `securityHeaders` is an
   * option for. A loopback issuer — `localhost`, `127.0.0.1`, `[::1]` — needs
   * nothing, because plaintext that never leaves the machine is the dev loop's
   * own Ory.
   */
  readonly allowInsecureIssuer?: boolean;
};

const DEFAULT_PREFIX = "/auth";
const DEFAULT_SCOPE = "openid";
const DEFAULT_POST_LOGOUT = "/";

/** The login flow's own state, while the browser is away at the provider. */
const TRANSIENT_COOKIE = "__Host-oidc";

// `request.url` is a path, so it needs an origin to parse against. Nothing
// reads this one: every URL built from the request is used for its path and
// query alone, and the grant's own is built from the REGISTERED redirect URI.
const RELATIVE = "http://request.invalid";

// No body on any of these: a refusal owes the caller nothing beyond the status,
// and a redirect's body is never read.
const send = (
  response: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders = {},
): void => {
  response.writeHead(status, headers);
  response.end();
};

/** The request's path relative to the mount. */
const pathOf = (target: URL, prefix: string): string => {
  const rest = target.pathname.slice(prefix.replace(/\/+$/, "").length);
  return rest === "" ? "/" : rest;
};

/** Everything the routes close over, decided once at boot. */
type Bound<P> = {
  readonly config: Configuration;
  readonly redirectUri: string;
  readonly scope: string;
  readonly postLogout: string;
  readonly principal: (claims: IDToken) => P | undefined;
  readonly observers: readonly ((operation: Operation) => Settle)[];
};

/**
 * One route of this answerer, observed — and ended by the RESPONSE rather than
 * only by the code path that wrote it.
 *
 * `observe`'s finisher is once-only, so an explicit `settle` below wins and the
 * `'close'` one is a no-op. It exists for the paths that reach no `settle` at
 * all: a `.get()` rethrowing a codec defect, or `calculatePKCECodeChallenge`
 * rejecting, leave an unended span and a request missing from the counters
 * entirely, which is worse than the defect. `'close'` is the one event that
 * always fires, and by then the runtime's own `500` is on the wire — which is
 * what `outcome` reads, exactly as `http-runtime.ts` reads it for the request.
 *
 * The `closed` check first, because subscribing to a stream that already fired
 * is this package's own documented footgun (`closedOf` in `http-runtime.ts`):
 * a client that hung up while the kernel was opening the unit is closed before
 * this route's first line.
 */
const observed = (
  observers: readonly ((operation: Operation) => Settle)[],
  name: string,
  response: ServerResponse,
): Settle => {
  const settle = observe(observers, { component: "oidc", name, attributes: {} });
  const end = (): void =>
    settle({
      outcome: response.statusCode >= 500 ? "error" : "ok",
      attributes: { status: response.statusCode },
    });
  if (response.closed) end();
  else response.once("close", end);
  return settle;
};

/**
 * Every callback refusal: the status, the reason, and the transient with it.
 *
 * **The reason leaves the process exactly once, through the observer**, and
 * never on the wire: a refusal carries a status and nothing else. `reason` is
 * the bounded half — five literal values, safe on an instrument — and `cause`
 * is the unbounded one, which is where a provider's own `error_description`
 * and a library error's message go: an observer puts a cause on a line or a
 * span, never on a metric.
 *
 * **The transient is cleared on every exit rather than on success alone**: the
 * flow state is spent the moment a callback has been seen, and one left for
 * five minutes is what a second tab's login collides with. That unconditional
 * header is still not a cross-site handle on somebody's login in flight, and
 * the reason is the BROWSER's, not this code's: `SameSite` gates `Set-Cookie`
 * in a cross-site context exactly as it gates `Cookie`, so the clearing header
 * a third-party `<img src="/auth/callback">` provokes is rejected before it
 * reaches the jar. `Max-Age=0` deletes a stored cookie whether or not the
 * request carried one — "there was nothing to delete" would be the wrong
 * argument for the right conclusion.
 */
const refuse = (
  response: ServerResponse,
  status: number,
  settle: Settle,
  reason: string,
  cause?: unknown,
): void => {
  settle({ outcome: "error", attributes: { reason }, cause });
  send(response, status, { "set-cookie": clearCookie(TRANSIENT_COOKIE) });
};

const login = async <P>(
  target: URL,
  response: ServerResponse,
  bound: Bound<P>,
  codec: SessionCodecService,
): Promise<void> => {
  observed(bound.observers, "login", response);
  const verifier = randomPKCECodeVerifier();
  const state = randomState();
  const nonce = randomNonce();
  const challenge = await calculatePKCECodeChallenge(verifier);
  const hint = target.searchParams.get("as");
  const sealed = await codec.transient
    .seal({ verifier, state, nonce, return: returnTo(target.searchParams.get("return")) })
    .get();

  send(response, 303, {
    location: buildAuthorizationUrl(bound.config, {
      redirect_uri: bound.redirectUri,
      scope: bound.scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
      ...(hint === null ? {} : { login_hint: hint }),
    }).href,
    "set-cookie": setCookie(TRANSIENT_COOKIE, sealed, TRANSIENT_TTL_SEC),
  });
};

const callback = async <P>(
  target: URL,
  request: IncomingMessage,
  response: ServerResponse,
  bound: Bound<P>,
  codec: SessionCodecService,
): Promise<void> => {
  const settle = observed(bound.observers, "callback", response);
  const held = await codec.transient
    .unseal(cookieValue(request.headers.cookie, TRANSIENT_COOKIE))
    .get();
  // No transient, one no key opens, one past its five minutes, or one naming a
  // different `state`: this callback belongs to somebody else's flow.
  if (held === undefined) {
    refuse(response, 400, settle, "transient_missing");
    return;
  }
  if (held["state"] !== target.searchParams.get("state")) {
    refuse(response, 400, settle, "state_mismatch");
    return;
  }

  // The provider refusing is not this end failing to understand: a user who
  // clicked Deny, a consent that expired. It arrives with a matching `state`,
  // so it would otherwise come out of the grant below as an indistinguishable
  // 401 with the reason discarded.
  const denied = target.searchParams.get("error");
  if (denied !== null) {
    // Both strings are the caller's — a matching `state` is all it takes to
    // craft an `error_description` — so they ride the CAUSE, the unbounded
    // half, and never the dimensions.
    refuse(
      response,
      401,
      settle,
      "provider_refused",
      new Error(`${denied}: ${target.searchParams.get("error_description") ?? ""}`),
    );
    return;
  }

  // The REGISTERED redirect URI carrying this request's query. Never `Host`,
  // which the caller writes — and it is also what makes the app reachable on
  // a port the provider was never told about.
  const currentUrl = new URL(bound.redirectUri);
  currentUrl.search = target.search;

  const granted = await fromPromise(
    authorizationCodeGrant(bound.config, currentUrl, {
      pkceCodeVerifier: held["verifier"] ?? "",
      expectedState: held["state"],
      expectedNonce: held["nonce"] ?? "",
    }),
    // The cause is KEPT rather than collapsed: a rotated client secret and a
    // dead token endpoint are both "every login 401s", and without a line
    // naming which, the only evidence either leaves is a spike of refusals.
    (cause) => new GrantFailed({ error: cause instanceof Error ? cause.name : "unknown", cause }),
  );
  if (!granted.isOk()) {
    refuse(response, 401, settle, "grant_failed", granted.isErr() ? granted.error : granted.cause);
    return;
  }

  const claims = granted.value.claims();
  const principal = claims === undefined ? undefined : bound.principal(claims);
  if (claims === undefined || principal === undefined) {
    refuse(response, 400, settle, "principal_refused");
    return;
  }

  // `scope` is space-delimited (RFC 8693) and is not a claim every provider
  // writes into an ID token; `sid` is the provider's own session id. Both are
  // taken only when they are strings, since the payload is a JSON document.
  const scope = claims["scope"];
  const sid = claims["sid"];
  const sealed = await codec
    .seal({
      principal,
      ...(typeof sid === "string" ? { sid } : {}),
      ...(typeof scope === "string" ? { scopes: scope.split(" ") } : {}),
    })
    .get();

  send(response, 303, {
    // `forLocation`, because Node's header validator refuses every code point
    // above U+00FF: `/订单/1` is an ordinary path and an `ERR_INVALID_CHAR`
    // otherwise — a 500 with the authorization code already spent.
    location: forLocation(returnTo(held["return"])),
    "set-cookie": [setCookie(SESSION_COOKIE, sealed, codec.ttlSec), clearCookie(TRANSIENT_COOKIE)],
  });
};

const logout = <P>(response: ServerResponse, bound: Bound<P>): void => {
  observed(bound.observers, "logout", response);
  const advertised = bound.config.serverMetadata().end_session_endpoint;
  send(response, 303, {
    // Parameterless: no `id_token_hint`, because the cookie holds a principal
    // and no token, and no `post_logout_redirect_uri`, which a provider is
    // entitled to refuse without one.
    location:
      advertised === undefined ? bound.postLogout : buildEndSessionUrl(bound.config, {}).href,
    "set-cookie": clearCookie(SESSION_COOKIE),
  });
};

/** A plaintext issuer that never leaves the machine: the dev loop's own Ory. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Whether this issuer may be talked to in cleartext, decided once at boot.
 *
 * `Config.url` says a value parses, not that it is safe: an `https:` issuer is
 * always fine, an `http:` one on a loopback host is the dev loop, and any
 * other `http:` issuer sends the client secret, the authorization code and
 * every token across the wire — with `allowInsecureRequests` turning off the
 * one check that would have refused to. That last case is a `ConfigInvalid` at
 * boot unless `allowInsecureIssuer` is pinned at the call, which is where a
 * security posture belongs.
 */
const insecureIssuer = (issuer: string, allowed: boolean): boolean | "refused" =>
  !issuer.startsWith("http:")
    ? false
    : allowed || LOOPBACK.has(new URL(issuer).hostname)
      ? true
      : "refused";

/**
 * The discovery document, once, at boot — so a provider that is not there is a
 * typed startup failure rather than a 500 on the first login, and so the JWKS
 * cache and the metadata are one per process rather than one per request.
 */
const discover = (
  issuer: string,
  clientId: string,
  clientSecret: string,
  // `http:` AND (loopback or the opt-in) — decided at boot by `insecureIssuer`
  // below, never re-derived here, so the check that refuses a cleartext issuer
  // and the switch that permits one cannot drift apart.
  insecure: boolean,
): AsyncResult<Configuration, OidcUnreachable> =>
  fromPromise(
    discovery(new URL(issuer), clientId, undefined, ClientSecretBasic(clientSecret), {
      execute: insecure ? [allowInsecureRequests] : [],
    }),
    (cause) => new OidcUnreachable({ issuer, cause }),
  ).map((config) => {
    // Applied TWICE for a permitted plaintext issuer: as a `discovery` option
    // and again on the configuration it answers, which that option does not
    // reach.
    if (insecure) allowInsecureRequests(config);
    // Without this nothing verifies the ID token's SIGNATURE: OIDC Core lets a
    // client trust a token that arrived over TLS from the token endpoint.
    enableNonRepudiationChecks(config);
    return config;
  });

const handlerFor =
  <P>(bound: Bound<P>, prefix: `/${string}`, codec: SessionCodecService): HttpAnswerer["handle"] =>
  async (request, response) => {
    const target = new URL(request.url ?? "/", RELATIVE);
    const route = `${request.method ?? ""} ${pathOf(target, prefix)}`;
    if (route === "GET /login") await login(target, response, bound, codec);
    else if (route === "GET /callback") await callback(target, request, response, bound, codec);
    else if (route === "POST /logout") logout(response, bound);
    // This answerer owns every path under its mount, so a path naming no route
    // is answered here rather than left for the runtime's own 404.
    else send(response, 404);
  };

/**
 * The login answerer: three routes that log a browser in over the
 * authorization-code flow with PKCE and hand the result to
 * {@link SessionCodec} as a session cookie.
 *
 * ```ts
 * export const BrowserApi = HttpModule("BrowserApi")({
 *   fragments,
 *   fragmentsLogin: "/auth/login",
 *   provides: [sessionCodec(), oidc({ principal: identityOf })],
 * });
 * ```
 *
 * - `GET <prefix>/login?return=<path>&as=<hint>` seals a PKCE verifier,
 *   `state`, `nonce` and where to return to into the five-minute
 *   `__Host-oidc` cookie and redirects to the provider. `return` is the seam
 *   `htmx({ login })` writes; `as` rides through as `login_hint`.
 * - `GET <prefix>/callback` checks `state` against that cookie, exchanges the
 *   code, and seals `principal(claims)` into `__Host-session` — clearing the
 *   transient in the same answer.
 * - `POST <prefix>/logout` clears the session and sends the browser to the
 *   provider's `end_session_endpoint`, or to `postLogout` when it advertises
 *   none.
 *
 * Each of the three routes is an OPERATION reported to {@link Observers}, the
 * way a cache read is: a refusal settles `error` carrying its own `reason`,
 * so a rotated client secret is one dimension rather than an indistinguishable
 * spike of bad logins. It costs a root nothing — `httpServer` already
 * contributes the no-op member — and a root composing `observability()` gets
 * the line for free.
 *
 * It injects {@link SessionCodec} rather than holding keys, so the codec that
 * seals a session here is the one `sessionAuthenticator` reads it back with —
 * and a root composing this without `sessionCodec()` is di's own unmet need
 * naming the port.
 */
export const oidc = <P>(options: OidcOptions<P>) => {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const schema = Config.object({
    issuer: Config.pinned(options.issuer, Config.url("HTTP_OIDC_ISSUER")),
    clientId: Config.pinned(options.clientId, Config.string("HTTP_OIDC_CLIENT_ID")),
    clientSecret: Config.pinned(options.clientSecret, Config.string("HTTP_OIDC_CLIENT_SECRET")),
    redirectUri: Config.pinned(options.redirectUri, Config.url("HTTP_OIDC_REDIRECT_URI")),
  });

  return Provider.member(HttpHandler)({
    inject: { env: Env, codec: SessionCodec, observers: Observers },
    make: ({ env, codec, observers }): AsyncResult<HttpAnswerer, ConfigInvalid | OidcUnreachable> =>
      Config.parse(
        "HttpOidc",
        schema,
      )(env).flatMap((bound): AsyncResult<HttpAnswerer, ConfigInvalid | OidcUnreachable> => {
        const insecure = insecureIssuer(bound.issuer, options.allowInsecureIssuer ?? false);
        if (insecure === "refused")
          return ErrAsync(
            new ConfigInvalid({
              port: "HttpOidc",
              issues: [
                {
                  message:
                    "must be an https: issuer — a cleartext one sends the client secret, the authorization code and every token in the open. Only a loopback host (localhost, 127.0.0.1, [::1]) is accepted without `allowInsecureIssuer: true` on `oidc()`",
                  path: ["HTTP_OIDC_ISSUER"],
                },
              ],
            }),
          );
        return discover(bound.issuer, bound.clientId, bound.clientSecret, insecure).map(
          (config) => ({
            prefix,
            handle: handlerFor(
              {
                config,
                redirectUri: bound.redirectUri,
                scope: options.scope ?? DEFAULT_SCOPE,
                postLogout: options.postLogout ?? DEFAULT_POST_LOGOUT,
                principal: options.principal,
                observers,
              },
              prefix,
              codec,
            ),
          }),
        );
      }),
  });
};
