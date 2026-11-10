import type { IncomingMessage, ServerResponse } from "node:http";

import {
  Config,
  cleartext,
  cleartextRefused,
  Env,
  ConfigInvalid,
  type EnvReading,
  type MaybePinned,
  type OptionsAs,
  type Unpinned,
} from "@btravstack/config";
import { Observers, observe, type Operation, type Settle } from "@btravstack/core";
import { Provider, type AnyPort, type AnyProvider, type PortClassOf } from "@btravstack/di";
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
  type IDToken,
} from "openid-client";
import { ErrAsync, Ok, TaggedError, fromPromise, type AsyncResult } from "unthrown";

import { clearCookie, cookieScheme, cookieValue, setCookie } from "./cookie.js";
import { HttpHandler, pathUnder, send, type HttpAnswerer } from "./handler.js";
import { discoverOidc, type OidcUnreachable } from "./oidc-discovery.js";
import { loginContextFor, type OidcLoginContext } from "./oidc-login-context.js";
import { logoutLocation } from "./oidc-logout-location.js";
import { logoutRedirectUri } from "./oidc-logout-uri.js";
import type { OidcLogoutContext, OidcTokensService } from "./oidc-token-store.js";
import { injectedDeps, injectedServices } from "./options.js";
import type { Injected, PrefixOf } from "./options.js";
import { forLocation, returnTo } from "./redirect.js";
import { requestMetadataOf } from "./request-metadata.js";
import {
  SESSION_COOKIE,
  SessionCodec,
  TRANSIENT_TTL_SEC,
  type SessionCodecService,
} from "./session.js";

export { OidcLoginRefused, type OidcLoginContext } from "./oidc-login-context.js";

export { OidcUnreachable } from "./oidc-discovery.js";

/** What `oidc()`'s pins are, as their own type: every one may be set. */
export type OidcPins = {
  readonly issuer?: string | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly redirectUri?: string | undefined;
  readonly postLogoutRedirectUri?: string | undefined;
};

/**
 * The answerer half of what {@link oidc} composes — the three login routes as
 * one `HttpHandler` member. The second half is a `CookieSchemes` member, which
 * carries no type of its own.
 */

export type OidcAnswerer<Pre extends string = string, O = OidcPins, Needs = never> = Provider<
  HttpHandler,
  ConfigInvalid | OidcUnreachable,
  | EnvReading<
      | Unpinned<O, "issuer", `${Pre}_ISSUER`>
      | Unpinned<O, "clientId", `${Pre}_CLIENT_ID`>
      | Unpinned<O, "clientSecret", `${Pre}_CLIENT_SECRET`>
      | (Unpinned<O, "redirectUri", `${Pre}_REDIRECT_URI`> &
          Unpinned<LoginContextOf<O>, "redirectUri", `${Pre}_REDIRECT_URI`>),
      | MaybePinned<O, "issuer", `${Pre}_ISSUER`>
      | MaybePinned<O, "clientId", `${Pre}_CLIENT_ID`>
      | MaybePinned<O, "clientSecret", `${Pre}_CLIENT_SECRET`>
      | Exclude<
          | MaybePinned<O, "redirectUri", `${Pre}_REDIRECT_URI`>
          | MaybePinned<LoginContextOf<O>, "redirectUri", `${Pre}_REDIRECT_URI`>,
          | Pinned<O, "redirectUri", `${Pre}_REDIRECT_URI`>
          | Pinned<LoginContextOf<O>, "redirectUri", `${Pre}_REDIRECT_URI`>
        >
      | Unpinned<O, "postLogoutRedirectUri", `${Pre}_POST_LOGOUT_REDIRECT_URI`>
      | MaybePinned<O, "postLogoutRedirectUri", `${Pre}_POST_LOGOUT_REDIRECT_URI`>
    >
  | SessionCodec
  | Observers
  | Needs
  | TokenNeeds<O>
> & { readonly port: typeof HttpHandler };

/** A login context deriving the redirect URI pins its variable the way the option does. */
type LoginContextOf<O> = O extends { readonly loginContext: infer L }
  ? L
  : O extends { readonly loginContext?: infer L }
    ? L | undefined
    : undefined;
/** `V` when `O` certainly sets `K`, so the variable leaves the environment. */
type Pinned<O, K extends PropertyKey, V extends string> = [
  Unpinned<O, K, V> | MaybePinned<O, K, V>,
] extends [never]
  ? V
  : never;

type TokenNeeds<O> = O extends { readonly tokens?: infer T }
  ? InstanceType<Extract<T, AnyPort>>
  : never;

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

export type OidcOptions<
  P,
  Pre extends string = string,
  D extends Readonly<Record<string, AnyPort>> = Record<never, never>,
  C = undefined,
> = {
  /** Pins `<prefix>_ISSUER` — the provider, as its discovery document names itself. */
  readonly issuer?: string | undefined;
  /** Pins `<prefix>_CLIENT_ID`. */
  readonly clientId?: string | undefined;
  /** Pins `<prefix>_CLIENT_SECRET` — this is a confidential client. */
  readonly clientSecret?: string | undefined;
  /**
   * Pins `<prefix>_REDIRECT_URI` — the URI REGISTERED with the provider, which
   * is also what the code grant is checked against. It is never rebuilt from
   * the request's `Host`. Neither it nor the variable is read when
   * `loginContext.redirectUri` derives one per context.
   */
  readonly redirectUri?: string | undefined;
  /**
   * Pins `<prefix>_POST_LOGOUT_REDIRECT_URI`, an absolute HTTP(S) URI registered
   * with the provider. Requires `tokens`; its server-only ID token is retrieved
   * while revoking credentials. Without a retained hint, logout stays parameterless.
   */
  readonly postLogoutRedirectUri?: string | undefined;
  /**
   * The prefix of the variables this login reads: `<prefix>_ISSUER`,
   * `<prefix>_CLIENT_ID`, `<prefix>_CLIENT_SECRET` and `<prefix>_REDIRECT_URI`.
   * The optional return URI uses `<prefix>_POST_LOGOUT_REDIRECT_URI`.
   * Default `HTTP_OIDC`. A second login names its own — `HTTP_OIDC_STAFF` — the
   * way a second `jwtAuthenticator` does.
   */
  readonly variablePrefix?: Pre;
  /** Where the three routes are mounted. Default `/auth`. */
  readonly prefix?: `/${string}`;
  /** What the authorization request asks for. Default `openid`. */
  readonly scope?: string;
  /**
   * The services `principal` reads, as a provider's `inject`: each port joins
   * the answerer's needs, and is resolved once, as the graph is built.
   */
  readonly inject?: D;
  /**
   * What the ID token's claims make the caller, given the services `inject`
   * names — the same shape `jwtAuthenticator` takes, so one function serves
   * both. Answering `undefined` refuses the login: the claim this application
   * requires and the standard does not, such as a tenant.
   */
  readonly principal: (claims: IDToken, services: Injected<D>, context: C) => P | undefined;
  /** Application context resolved before redirect and validated again before admission. */
  readonly loginContext?: OidcLoginContext<C, D>;
  /** Server-side token manager. Its binding must match this login. */
  readonly tokens?: PortClassOf<string, OidcTokensService>;
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

type ContextGate<C, D extends Readonly<Record<string, AnyPort>>> = unknown extends C
  ? { readonly loginContext: OidcLoginContext<C, D> }
  : [C, undefined] extends [undefined, C]
    ? unknown
    : { readonly loginContext: OidcLoginContext<C, D> };

const DEFAULT_PREFIX = "/auth";
const DEFAULT_SCOPE = "openid";
const DEFAULT_POST_LOGOUT = "/";

/** The login flow's own state, while the browser is away at the provider. */
const TRANSIENT_COOKIE = "__Host-oidc";
const MAX_TRANSIENT_COOKIE_BYTES = 4096;

// `request.url` is a path, so it needs an origin to parse against. Nothing
// reads this one: every URL built from the request is used for its path and
// query alone, and the grant's own is built from the BOUND redirect URI.
const RELATIVE = "http://request.invalid";

/** Everything the routes close over, decided once at boot. */
type Bound<P> = {
  readonly flowBinding: (redirectUri: string) => string;
  readonly loginContext?: ReturnType<typeof loginContextFor<unknown, Record<never, never>>>;
  readonly config: Configuration;
  readonly tokens?: OidcTokensService;
  /** The issuer and client id as configured, sealed into every session so its scheme can tell logins apart. */
  readonly issuer: string;
  readonly clientId: string;
  /** The static redirect URI; absent when the login context derives one. */
  readonly redirectUri: string | undefined;
  readonly scope: string;
  readonly postLogout: string;
  readonly postLogoutRedirectUri?: string;
  /** Whether logout asks the token manager for a hint and a return to send the provider. */
  readonly logoutReturns: boolean;
  readonly principal: (claims: IDToken, context: unknown) => P | undefined;
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
 * the bounded half — literal values, safe on an instrument — and `cause`
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
  request: IncomingMessage,
  signal: AbortSignal,
  response: ServerResponse,
  bound: Bound<P>,
  codec: SessionCodecService,
): Promise<void> => {
  const settle = observed(bound.observers, "login", response);
  const context = await bound.loginContext?.prepare(requestMetadataOf(request, signal)).get();
  const redirectUri = context?.redirectUri ?? bound.redirectUri;
  if ((bound.loginContext !== undefined && context === undefined) || redirectUri === undefined) {
    refuse(response, 400, settle, "login_context_refused");
    return;
  }
  const verifier = randomPKCECodeVerifier();
  const state = randomState();
  const nonce = randomNonce();
  const challenge = await calculatePKCECodeChallenge(verifier);
  const hint = target.searchParams.get("as");
  const flow = {
    verifier,
    state,
    nonce,
    return: returnTo(target.searchParams.get("return")),
    ...(context === undefined
      ? {}
      : { context: context.serialized, binding: bound.flowBinding(redirectUri) }),
  };
  let sealed = await codec.transient.seal(flow).get();
  let cookie = setCookie(TRANSIENT_COOKIE, sealed, TRANSIENT_TTL_SEC);
  if (Buffer.byteLength(cookie) > MAX_TRANSIENT_COOKIE_BYTES) {
    sealed = await codec.transient.seal({ ...flow, return: "/" }).get();
    cookie = setCookie(TRANSIENT_COOKIE, sealed, TRANSIENT_TTL_SEC);
  }
  if (Buffer.byteLength(cookie) > MAX_TRANSIENT_COOKIE_BYTES) {
    refuse(response, 400, settle, "transient_too_large");
    return;
  }

  send(response, 303, {
    location: buildAuthorizationUrl(bound.config, {
      ...Object.fromEntries(context?.parameters ?? []),
      redirect_uri: redirectUri,
      scope: bound.scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
      ...(hint === null || bound.loginContext !== undefined ? {} : { login_hint: hint }),
    }).href,
    "set-cookie": cookie,
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

  // The context's URIs are derived again, so the binding names the redirect URI
  // this transaction was sent with.
  const recovered = await bound.loginContext?.read(held["context"]).get();
  const redirectUri = recovered?.redirectUri ?? bound.redirectUri;
  if (
    redirectUri === undefined ||
    (bound.loginContext !== undefined &&
      (recovered === undefined || held["binding"] !== bound.flowBinding(redirectUri)))
  ) {
    refuse(response, 400, settle, "login_context_refused");
    return;
  }
  // A derived redirect URI names one host: a callback the browser delivered
  // anywhere else would seal another context's session there.
  if (recovered?.redirectUri !== undefined && !arrivedAt(target, request, recovered.redirectUri)) {
    refuse(response, 400, settle, "redirect_uri_mismatch");
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

  // The BOUND redirect URI carrying this request's query, which `openid-client`
  // also sends as the exchange's `redirect_uri`. Never `Host`, which the caller
  // writes — and it is also what makes the app reachable on a port the
  // provider was never told about.
  const currentUrl = new URL(redirectUri);
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
  const principal = claims === undefined ? undefined : bound.principal(claims, recovered?.context);
  if (claims === undefined || principal === undefined) {
    refuse(response, 400, settle, "principal_refused");
    return;
  }

  // `scope` is space-delimited (RFC 8693) and is not a claim every provider
  // writes into an ID token; `sid` is the provider's own session id. Both are
  // taken only when they are strings, since the payload is a JSON document.
  const scope = claims["scope"];
  const sid = claims["sid"];
  const session = {
    principal,
    iss: bound.issuer,
    clientId: bound.clientId,
    ...(typeof sid === "string" ? { sid } : {}),
    ...(typeof scope === "string" ? { scopes: scope.split(" ") } : {}),
  };
  const tokens = bound.tokens;
  const sealed =
    tokens === undefined
      ? await codec.seal(session).get()
      : await tokens
          .invalidate(cookieValue(request.headers.cookie, SESSION_COOKIE))
          .flatMap(() =>
            tokens.create(session, claims.sub, granted.value, recovered?.postLogoutRedirectUri),
          )
          .getOrUndefined();
  if (sealed === undefined) {
    refuse(response, 503, settle, "token_store_failed");
    return;
  }

  send(response, 303, {
    // `forLocation`, because Node's header validator refuses every code point
    // above U+00FF: `/订单/1` is an ordinary path and an `ERR_INVALID_CHAR`
    // otherwise — a 500 with the authorization code already spent.
    location: forLocation(returnTo(held["return"])),
    "set-cookie": [setCookie(SESSION_COOKIE, sealed, codec.ttlSec), clearCookie(TRANSIENT_COOKIE)],
  });
};

const logout = async <P>(
  request: IncomingMessage,
  response: ServerResponse,
  bound: Bound<P>,
): Promise<void> => {
  observed(bound.observers, "logout", response);
  let context: OidcLogoutContext | undefined;
  if (bound.tokens !== undefined) {
    const cookie = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const invalidated = await (bound.logoutReturns
      ? bound.tokens.logout(cookie)
      : bound.tokens.invalidate(cookie).map(() => undefined));
    if (!invalidated.isOk()) {
      invalidated.getOrUndefined();
      send(response, 503, { "set-cookie": clearCookie(SESSION_COOKIE) });
      return;
    }
    context = invalidated.value;
  }
  send(response, 303, {
    location: logoutLocation(bound.config, bound.postLogout, bound.postLogoutRedirectUri, context),
    "set-cookie": clearCookie(SESSION_COOKIE),
  });
};

/**
 * Whether the browser addressed `redirectUri`'s host and path: the request
 * target's own authority in absolute form, `Host` otherwise. A comparison, never
 * a source — no URI is built from either. The scheme is not compared: behind a
 * TLS-terminating proxy this process cannot observe it.
 */
const arrivedAt = (target: URL, request: IncomingMessage, redirectUri: string): boolean => {
  const expected = new URL(redirectUri);
  const host = URL.parse(request.url ?? "/")?.host ?? request.headers.host?.toLowerCase();
  return host === expected.host && target.pathname === expected.pathname;
};

const handlerFor =
  <P>(bound: Bound<P>, prefix: `/${string}`, codec: SessionCodecService): HttpAnswerer["handle"] =>
  async (request, response, signal) => {
    const route = `${request.method ?? ""} ${pathUnder(request.url, prefix)}`;
    // Parsed again for its query, and asserted: a target no parser accepts
    // reads as the mount itself, which names no route, so none reads this.
    const target = URL.parse(request.url ?? "/", RELATIVE) as URL;
    if (route === "GET /login") await login(target, request, signal, response, bound, codec);
    else if (route === "GET /callback") await callback(target, request, response, bound, codec);
    else if (route === "POST /logout") await logout(request, response, bound);
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
 *   provides: [sessionCodec(), oidc()({ principal: identityOf })],
 * });
 * ```
 *
 * - `GET <prefix>/login?return=<path>&as=<hint>` seals a PKCE verifier,
 *   `state`, `nonce` and where to return to into the five-minute
 *   `__Host-oidc` cookie and redirects to the provider. `return` is the seam
 *   `htmx({ login })` writes; `as` rides through as `login_hint`.
 *   An oversized sealed cookie retries with `/` as its return destination;
 *   if it still exceeds 4096 bytes including cookie attributes, login refuses.
 * - `GET <prefix>/callback` checks `state` against that cookie, exchanges the
 *   code, and seals `principal(claims)` into `__Host-session` — clearing the
 *   transient in the same answer.
 * - `POST <prefix>/logout` clears the session and sends the browser to the
 *   provider's `end_session_endpoint`, or to `postLogout` when it advertises
 *   none. A configured `postLogoutRedirectUri` adds the registered return and
 *   the bound server-side ID-token hint while invalidating credentials atomically.
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
 *
 * **It answers TWO providers, and the second is why they are spread**: the
 * answerer, and a {@link CookieSchemes} member, because this is a cookie-reading
 * surface and `csrf`'s default is a fact about the graph rather than a line
 * somebody remembered to write. Without it a root composing `oidc()` and
 * `sessionCodec()` but no `sessionAuthenticator` served a state-changing
 * `POST <prefix>/logout` over a cookie with CSRF off — the composition the
 * package's own spec called "does not work at all", which nonetheless logs a
 * browser in and exposes the logout. `defineHttp` already spreads the same
 * member beside a scheme that reads one; this is that rule reaching the one
 * surface it could not see.
 */
// Curried, as `jwtAuthenticator<P>()` is: an explicit `P` in the second call
// would default `D` and `O` rather than infer them. `O` is the options as
// written, naked so a union or an annotated type is inferred whole, and `D` is
// read off `inject` before `principal` is typed.
export const oidc =
  <P = unknown, C = undefined>() =>
  <
    const D extends Readonly<Record<string, AnyPort>> = Record<never, never>,
    const O extends OidcOptions<P, string, D, C> = OidcOptions<P, string, D, C>,
  >(
    options: O &
      OptionsAs<O, OidcOptions<P, string, D, C>> & { readonly inject?: D } & ContextGate<C, D>,
  ): readonly [
    OidcAnswerer<PrefixOf<O, "HTTP_OIDC">, O, InstanceType<D[keyof D]>>,
    AnyProvider,
  ] => {
    type Pre = PrefixOf<O, "HTTP_OIDC">;
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    const variables = (options.variablePrefix ?? "HTTP_OIDC") as Pre;
    const loginContext = options.loginContext;
    const schema = Config.object({
      issuer: Config.pinned(options.issuer, Config.url(`${variables}_ISSUER`)),
      clientId: Config.pinned(options.clientId, Config.string(`${variables}_CLIENT_ID`)),
      clientSecret: Config.pinned(
        options.clientSecret,
        Config.string(`${variables}_CLIENT_SECRET`),
      ),
      redirectUri:
        loginContext?.redirectUri === undefined
          ? Config.pinned(options.redirectUri, Config.url(`${variables}_REDIRECT_URI`))
          : // Never read: the login context derives the redirect URI per context.
            { variable: `${variables}_REDIRECT_URI`, parse: () => Ok(undefined) },
      postLogoutRedirectUri: Config.pinned(
        options.postLogoutRedirectUri,
        logoutRedirectUri(`${variables}_POST_LOGOUT_REDIRECT_URI`),
      ),
    });

    // Cast for the needs alone: over a generic prefix the schema's own needs type
    // cannot resolve, so `OidcAnswerer` states the four variables.
    const answerer = Provider.member(HttpHandler)({
      inject: {
        env: Env,
        codec: SessionCodec,
        observers: Observers,
        ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
        ...injectedDeps(options.inject),
      },
      make: ({
        env,
        codec,
        observers,
        tokens,
        ...services
      }): AsyncResult<HttpAnswerer, ConfigInvalid | OidcUnreachable> =>
        Config.parse(
          "HttpOidc",
          schema,
        )(env).flatMap((bound): AsyncResult<HttpAnswerer, ConfigInvalid | OidcUnreachable> => {
          if (
            (bound.postLogoutRedirectUri !== undefined ||
              loginContext?.postLogoutRedirectUri !== undefined) &&
            tokens === undefined
          )
            return ErrAsync(
              new ConfigInvalid({
                port: "HttpOidc",
                issues: [
                  {
                    message: "a post-logout return URI requires a server-side token manager",
                    path: [
                      bound.postLogoutRedirectUri === undefined
                        ? "loginContext.postLogoutRedirectUri"
                        : `${variables}_POST_LOGOUT_REDIRECT_URI`,
                    ],
                  },
                ],
              }),
            );
          if (
            tokens !== undefined &&
            (tokens.issuer !== bound.issuer || tokens.clientId !== bound.clientId)
          )
            return ErrAsync(
              new ConfigInvalid({
                port: "HttpOidc",
                issues: [
                  {
                    message: "the token manager must use this login's issuer and client id",
                    path: [`${variables}_ISSUER`, `${variables}_CLIENT_ID`],
                  },
                ],
              }),
            );
          const insecure = cleartext(bound.issuer, options.allowInsecureIssuer ?? false);
          if (insecure === "refused")
            return ErrAsync(
              cleartextRefused({
                port: "HttpOidc",
                variable: `${variables}_ISSUER`,
                option: "allowInsecureIssuer",
                on: "oidc()",
                what: "it sends the client secret, the authorization code and every token in the open",
              }),
            );
          return discoverOidc(bound.issuer, bound.clientId, bound.clientSecret, insecure).map(
            (config) => ({
              prefix,
              handle: handlerFor(
                {
                  config,
                  flowBinding: (redirectUri) =>
                    JSON.stringify([bound.issuer, bound.clientId, redirectUri, prefix]),
                  ...(loginContext === undefined
                    ? {}
                    : {
                        loginContext: loginContextFor(
                          loginContext,
                          injectedServices(services) as Injected<D>,
                          `${prefix.replace(/\/+$/, "")}/callback`,
                        ),
                      }),
                  ...(tokens === undefined ? {} : { tokens }),
                  issuer: bound.issuer,
                  clientId: bound.clientId,
                  redirectUri: bound.redirectUri,
                  scope: options.scope ?? DEFAULT_SCOPE,
                  postLogout: options.postLogout ?? DEFAULT_POST_LOGOUT,
                  ...(bound.postLogoutRedirectUri === undefined
                    ? {}
                    : { postLogoutRedirectUri: bound.postLogoutRedirectUri }),
                  logoutReturns:
                    bound.postLogoutRedirectUri !== undefined ||
                    loginContext?.postLogoutRedirectUri !== undefined,
                  principal: (claims, context) =>
                    options.principal(
                      claims,
                      injectedServices(services) as Injected<D>,
                      context as C,
                    ),
                  observers,
                },
                prefix,
                codec,
              ),
            }),
          );
        }),
    });

    return [answerer as unknown as OidcAnswerer<Pre, O, InstanceType<D[keyof D]>>, cookieScheme()];
  };
