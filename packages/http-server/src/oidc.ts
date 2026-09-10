import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import { Logger, type Attributes, type LoggerService } from "@btravstack/core";
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
import { TaggedError, fromPromise, type AsyncResult } from "unthrown";

import { clearCookie, cookieValue, setCookie } from "./cookie.js";
import { HttpHandler, type HttpAnswerer } from "./handler.js";
import { returnTo } from "./redirect.js";
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
  readonly logger: LoggerService;
};

/**
 * Every callback refusal, and the transient goes with it.
 *
 * Cleared on every exit rather than on success alone: the flow state is spent
 * the moment a callback has been seen, and a stale one left for five minutes
 * is what a second tab's login would collide with. It also means the reason
 * leaves the process exactly once — on the `warn` line above the call — and
 * never on the wire: a refusal carries a status and nothing else.
 */
const refuse = (
  response: ServerResponse,
  status: number,
  logger: LoggerService,
  attributes: Attributes,
  cause?: unknown,
): void => {
  logger.warn("oidc login refused", attributes, cause);
  send(response, status, { "set-cookie": clearCookie(TRANSIENT_COOKIE) });
};

const login = async <P>(
  target: URL,
  response: ServerResponse,
  bound: Bound<P>,
  codec: SessionCodecService,
): Promise<void> => {
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
  const held = await codec.transient
    .unseal(cookieValue(request.headers.cookie, TRANSIENT_COOKIE))
    .get();
  // No transient, one no key opens, one past its five minutes, or one naming a
  // different `state`: this callback belongs to somebody else's flow.
  if (held === undefined) {
    refuse(response, 400, bound.logger, { reason: "transient_missing" });
    return;
  }
  if (held["state"] !== target.searchParams.get("state")) {
    refuse(response, 400, bound.logger, { reason: "state_mismatch" });
    return;
  }

  // The provider refusing is not this end failing to understand: a user who
  // clicked Deny, a consent that expired. It arrives with a matching `state`,
  // so it would otherwise come out of the grant below as an indistinguishable
  // 401 with the reason discarded.
  const denied = target.searchParams.get("error");
  if (denied !== null) {
    refuse(response, 401, bound.logger, {
      reason: "provider_refused",
      error: denied,
      description: target.searchParams.get("error_description") ?? undefined,
    });
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
    (cause) => cause,
  );
  if (!granted.isOk()) {
    // `fromPromise`'s mapper is the identity here, so the only route to this
    // branch is a rejected grant; a Defect would have to come from the mapper.
    const cause = granted.isErr() ? granted.error : undefined;
    refuse(
      response,
      401,
      bound.logger,
      { reason: "grant_failed", error: cause instanceof Error ? cause.name : "unknown" },
      cause,
    );
    return;
  }

  const claims = granted.value.claims();
  const principal = claims === undefined ? undefined : bound.principal(claims);
  if (claims === undefined || principal === undefined) {
    refuse(response, 400, bound.logger, { reason: "principal_refused" });
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
    location: returnTo(held["return"]),
    "set-cookie": [setCookie(SESSION_COOKIE, sealed, codec.ttlSec), clearCookie(TRANSIENT_COOKIE)],
  });
};

const logout = <P>(response: ServerResponse, bound: Bound<P>): void => {
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

/**
 * The discovery document, once, at boot — so a provider that is not there is a
 * typed startup failure rather than a 500 on the first login, and so the JWKS
 * cache and the metadata are one per process rather than one per request.
 */
const discover = (
  issuer: string,
  clientId: string,
  clientSecret: string,
): AsyncResult<Configuration, OidcUnreachable> => {
  // A plaintext issuer is a development one, and the option does NOT carry over
  // to the configuration discovery answers — both are needed, and only then.
  const insecure = issuer.startsWith("http:");
  return fromPromise(
    discovery(new URL(issuer), clientId, undefined, ClientSecretBasic(clientSecret), {
      execute: insecure ? [allowInsecureRequests] : [],
    }),
    (cause) => new OidcUnreachable({ issuer, cause }),
  ).map((config) => {
    if (insecure) allowInsecureRequests(config);
    // Without this nothing verifies the ID token's SIGNATURE: OIDC Core lets a
    // client trust a token that arrived over TLS from the token endpoint.
    enableNonRepudiationChecks(config);
    return config;
  });
};

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
 * It also injects {@link Logger}, which `orpc()` and `htmx()` do not: a
 * refused login is the one refusal in this package that DESTROYS information.
 * The caller is told a bare status on purpose, the provider's reason never
 * crosses the wire, and a 401 is not an error the runtime's RED metrics count
 * — so a rotated client secret would read as a spike of bad logins with no
 * line anywhere naming it.
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
    inject: { env: Env, codec: SessionCodec, logger: Logger },
    make: ({ env, codec, logger }): AsyncResult<HttpAnswerer, ConfigInvalid | OidcUnreachable> =>
      Config.parse(
        "HttpOidc",
        schema,
      )(env).flatMap((bound) =>
        discover(bound.issuer, bound.clientId, bound.clientSecret).map((config) => ({
          prefix,
          handle: handlerFor(
            {
              config,
              redirectUri: bound.redirectUri,
              scope: options.scope ?? DEFAULT_SCOPE,
              postLogout: options.postLogout ?? DEFAULT_POST_LOGOUT,
              principal: options.principal,
              logger,
            },
            prefix,
            codec,
          ),
        })),
      ),
  });
};
