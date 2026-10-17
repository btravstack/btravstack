import { createHash } from "node:crypto";

import {
  Config,
  Env,
  cleartext,
  cleartextRefused,
  type ConfigInvalid,
  type EnvReading,
  type MaybePinned,
  type OptionsAs,
  type Unpinned,
} from "@btravstack/config";
import {
  HealthCheckFailed,
  HealthChecks,
  Observers,
  noObserverMember,
  observed,
  systemClock,
  type Clock,
  type Operation,
  type Settle,
} from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import {
  ClientSecretBasic,
  ResponseBodyError,
  WWWAuthenticateChallengeError,
  allowInsecureRequests,
  clientCredentialsGrant,
  customFetch,
  discovery,
  genericGrantRequest,
  type Configuration,
  type CustomFetch,
} from "openid-client";
import { ErrAsync, OkAsync, fromPromise, type AsyncResult, type FailureView } from "unthrown";

import {
  TokenIssuerUnavailable,
  TokenRefused,
  TokenSource,
  type AccessToken,
  type TokenRequest,
  type TokenSourceService,
} from "./token-source.js";

/** What {@link oauthClient} is handed. Each of the first three pins the variable named beside it. */
export type OAuthClientOptions = {
  /** Pins `OAUTH_ISSUER` — the authorization server, as its discovery document names itself. */
  readonly issuer?: string | undefined;
  /** Pins `OAUTH_CLIENT_ID`. */
  readonly clientId?: string | undefined;
  /** Pins `OAUTH_CLIENT_SECRET`. A deployment sets the variable, from a Secret. */
  readonly clientSecret?: string | undefined;
  /**
   * Talk to an `http:` issuer that is NOT on a loopback host. Default `false`,
   * and a `ConfigInvalid` at boot without it: the client secret and every
   * token cross the wire in the open. An option rather than a variable,
   * because its silent change is a security regression.
   */
  readonly allowInsecureIssuer?: boolean;
  /** What a token's lifetime is measured against (default: the kernel's `systemClock`). */
  readonly clock?: Clock | undefined;
  /** Application-owned fetch boundary, used for both discovery and token requests. */
  readonly fetch?: typeof fetch;
};

/**
 * How long before its stated expiry a token stops being handed out: it must
 * outlive the request it rides, through the callee's queue and a clock that
 * disagrees with this one. Capped at half a lifetime, so a short-lived token
 * is still reused.
 */
const SKEW_MS = 60_000;
const CACHE_CAPACITY = 1024;

type Observer = (operation: Operation) => Settle;
type TokenError = TokenRefused | TokenIssuerUnavailable;

type Settings = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly insecure: boolean;
};

type Fetches = {
  readonly source: TokenSourceService;
  readonly health: () => AsyncResult<void, HealthCheckFailed>;
};

/** The source and its health, built once, so the check reads the same fetches the callers make. */
class TokenFetches extends Port("OAuthTokenFetches")<Fetches> {}

const fetching = (request: TokenRequest): Operation => ({
  component: "oauth-client",
  name: "token",
  attributes: { operation: "token", "btravstack.oauth.audience": request.audience },
  details: { "btravstack.oauth.scope": request.scope ?? "" },
});

/**
 * What the issuer said no with, when the answer was a refusal rather than an
 * outage. A challenge is RFC 6749 §5.2's `401` for a rejected client, which
 * is `invalid_client` by definition.
 */
const refusalOf = (cause: unknown) =>
  cause instanceof WWWAuthenticateChallengeError
    ? { error: "invalid_client", description: undefined }
    : cause instanceof ResponseBodyError && cause.status < 500
      ? { error: cause.error, description: cause.error_description }
      : undefined;

const reasonOf = (audience: string, failure: FailureView<TokenError, unknown>): string =>
  failure.tag === "Err" && failure.error._tag === "TokenRefused"
    ? `${audience}: refused (${failure.error.error})`
    : `${audience}: the issuer could not be asked`;

const tokenFetches = (
  settings: Settings,
  observers: readonly Observer[],
  clock: Clock,
  transport: typeof fetch | undefined,
): Fetches => {
  const fetch: CustomFetch | undefined =
    transport === undefined
      ? undefined
      : (url, { body, ...options }) =>
          transport(url, { ...options, ...(body === undefined ? {} : { body }) });
  let configuration: AsyncResult<Configuration, TokenIssuerUnavailable> | undefined;
  const cached = new Map<string, { readonly token: AccessToken; readonly refreshAt: number }>();
  const inFlight = new Map<string, AsyncResult<AccessToken, TokenError>>();
  const failing = new Map<string, string>();
  const latestFetch = new Map<string, symbol>();

  const discover = (): AsyncResult<Configuration, TokenIssuerUnavailable> => {
    // Inside the promise: a pinned value skips validation, and `new URL` or
    // `ClientSecretBasic("")` throws synchronously, past `fromPromise`.
    configuration ??= fromPromise(
      Promise.resolve().then(() =>
        discovery(
          new URL(settings.issuer),
          settings.clientId,
          undefined,
          ClientSecretBasic(settings.clientSecret),
          {
            execute: settings.insecure ? [allowInsecureRequests] : [],
            ...(fetch === undefined ? {} : { [customFetch]: fetch }),
          },
        ),
      ),
      (cause) => new TokenIssuerUnavailable({ issuer: settings.issuer, cause }),
    )
      .map((config) => {
        // The `execute` option does not reach the configuration it answers.
        if (settings.insecure) allowInsecureRequests(config);
        if (fetch !== undefined) config[customFetch] = fetch;
        return config;
      })
      .tapFailure(() => {
        configuration = undefined;
      });
    return configuration;
  };

  const grant = (request: TokenRequest, config: Configuration) =>
    fromPromise(
      request.onBehalfOf === undefined
        ? clientCredentialsGrant(config, {
            audience: request.audience,
            ...(request.scope === undefined ? {} : { scope: request.scope }),
          })
        : genericGrantRequest(config, "urn:ietf:params:oauth:grant-type:token-exchange", {
            audience: request.audience,
            ...(request.scope === undefined ? {} : { scope: request.scope }),
            subject_token: request.onBehalfOf.token,
            subject_token_type: request.onBehalfOf.tokenType,
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            ...(request.onBehalfOf.actor === undefined
              ? {}
              : {
                  actor_token: request.onBehalfOf.actor.token,
                  actor_token_type: request.onBehalfOf.actor.tokenType,
                }),
          }),
      (cause): TokenError => {
        const refusal = refusalOf(cause);
        return refusal === undefined
          ? new TokenIssuerUnavailable({ issuer: settings.issuer, cause })
          : new TokenRefused({ audience: request.audience, ...refusal });
      },
    );

  const fetchToken = (key: string, request: TokenRequest): AsyncResult<AccessToken, TokenError> => {
    const asked = clock.now();
    const healthKey = JSON.stringify([request.audience, request.scope ?? null]);
    const generation = Symbol();
    latestFetch.set(healthKey, generation);
    const fetched = observed(observers, fetching(request), () =>
      discover().flatMap((config) => grant(request, config)),
    )
      .map((response) => {
        const lifetimeMs = (response.expires_in ?? 0) * 1_000;
        return {
          token: { bearer: response.access_token },
          refreshAt: asked + lifetimeMs - Math.min(SKEW_MS, lifetimeMs / 2),
        };
      })
      .tap((entry) => {
        inFlight.delete(key);
        if (latestFetch.get(healthKey) === generation) {
          latestFetch.delete(healthKey);
          failing.delete(healthKey);
        }
        cached.set(key, entry);
        if (cached.size > CACHE_CAPACITY) cached.delete(cached.keys().next().value!);
      })
      .tapFailure((failure) => {
        inFlight.delete(key);
        if (latestFetch.get(healthKey) === generation) {
          latestFetch.delete(healthKey);
          failing.set(healthKey, reasonOf(request.audience, failure));
        }
      })
      .map((entry) => entry.token);
    inFlight.set(key, fetched);
    return fetched;
  };

  return {
    source: {
      token: (input) => {
        const { audience, scope, onBehalfOf } = input;
        const actor = onBehalfOf?.actor;
        const request: TokenRequest = {
          audience,
          ...(scope === undefined ? {} : { scope }),
          ...(onBehalfOf === undefined
            ? {}
            : {
                onBehalfOf: {
                  token: onBehalfOf.token,
                  tokenType: onBehalfOf.tokenType,
                  ...(actor === undefined
                    ? {}
                    : { actor: { token: actor.token, tokenType: actor.tokenType } }),
                },
              }),
        };
        const key = createHash("sha256")
          .update(
            JSON.stringify([
              request.audience,
              request.scope ?? null,
              request.onBehalfOf?.token ?? null,
              request.onBehalfOf?.tokenType ?? null,
              request.onBehalfOf?.actor?.token ?? null,
              request.onBehalfOf?.actor?.tokenType ?? null,
            ]),
          )
          .digest("hex");
        const hit = cached.get(key);
        if (hit !== undefined && clock.now() < hit.refreshAt) return OkAsync(hit.token);
        cached.delete(key);
        return inFlight.get(key) ?? fetchToken(key, request);
      },
    },
    health: () =>
      failing.size === 0
        ? OkAsync()
        : ErrAsync(new HealthCheckFailed({ reason: [...failing.values()].join("; ") })),
  };
};

/**
 * `TokenSource` over an OAuth 2.0 authorization server: client credentials
 * for the service itself, or RFC 8693 token exchange for a subject.
 *
 * ```ts
 * Module("Gateway")({ imports: [oauthClient()], provides: [ordersClient] });
 * ```
 *
 * - **Configured from `OAUTH_ISSUER`, `OAUTH_CLIENT_ID` and
 *   `OAUTH_CLIENT_SECRET`**, each pinned by its option, validated as the graph
 *   is built. A cleartext issuer off loopback is a `ConfigInvalid` unless
 *   `allowInsecureIssuer` is pinned.
 * - **Discovery is lazy**: the first token asks for the issuer's metadata, and
 *   a failed discovery is asked again by the next. An authorization server
 *   down at deploy fails the calls that need a token, not the boot.
 * - **A token is kept per audience, scope and subject/actor credentials** until a minute before it
 *   expires (half its lifetime, if that is shorter), and callers asking for
 *   the same one while it is being fetched share that one request. A failure
 *   is never kept. The source keeps at most 1024 tokens, evicting the oldest
 *   insertion at capacity and removing stale entries when accessed.
 *   The complete request is snapshotted at entry, so caller mutation cannot
 *   change the credential or grant associated with its cache key.
 * - **Every fetch is reported to `Observers`** (`component: "oauth-client"`);
 *   a token served from memory reports nothing.
 * - **It contributes the `oauth-client` health check**, failing while the
 *   newest-started fetch of any audience/scope pair failed — a rotated secret and an unreachable
 *   issuer both show there, where a reachability probe would see only the
 *   second.
 */
export const oauthClient = <const O extends OAuthClientOptions = Record<never, never>>(
  // `{}` only when the argument is omitted, which is when `O` is `{}` too.
  options: O & OptionsAs<O, OAuthClientOptions> = {} as never,
): Module<
  TokenSource | HealthChecks,
  ConfigInvalid,
  EnvReading<
    | Unpinned<O, "issuer", "OAUTH_ISSUER">
    | Unpinned<O, "clientId", "OAUTH_CLIENT_ID">
    | Unpinned<O, "clientSecret", "OAUTH_CLIENT_SECRET">,
    | MaybePinned<O, "issuer", "OAUTH_ISSUER">
    | MaybePinned<O, "clientId", "OAUTH_CLIENT_ID">
    | MaybePinned<O, "clientSecret", "OAUTH_CLIENT_SECRET">
  >
> => {
  const clock = options.clock ?? systemClock;
  const schema = Config.object({
    issuer: Config.pinned(options.issuer, Config.url("OAUTH_ISSUER")),
    clientId: Config.pinned(options.clientId, Config.string("OAUTH_CLIENT_ID")),
    clientSecret: Config.pinned(options.clientSecret, Config.string("OAUTH_CLIENT_SECRET")),
  });

  const fetches = Provider(TokenFetches)({
    inject: { env: Env, observers: Observers },
    make: ({ env, observers }): AsyncResult<Fetches, ConfigInvalid> =>
      Config.parse(
        "OAuthClient",
        schema,
      )(env).flatMap((bound): AsyncResult<Fetches, ConfigInvalid> => {
        const insecure = cleartext(bound.issuer, options.allowInsecureIssuer ?? false);
        return insecure === "refused"
          ? ErrAsync(
              cleartextRefused({
                port: "OAuthClient",
                variable: "OAUTH_ISSUER",
                option: "allowInsecureIssuer",
                on: "oauthClient()",
                what: "it sends the client secret and every token in the open",
              }),
            )
          : OkAsync(tokenFetches({ ...bound, insecure }, observers, clock, options.fetch));
      }),
  });

  // Cast for the needs alone: over generic options the schema's own needs type
  // cannot resolve, so the annotation states the three variables.
  return Module("OAuthClient")({
    needs: [Env],
    provides: [
      noObserverMember,
      fetches,
      Provider(TokenSource)({
        inject: { fetches: TokenFetches },
        sync: ({ fetches: built }) => built.source,
      }),
      Provider.member(HealthChecks)({
        inject: { fetches: TokenFetches },
        sync: ({ fetches: built }) => ({ name: "oauth-client", check: built.health }),
      }),
    ],
    exports: [TokenSource, HealthChecks],
  }) as never;
};
