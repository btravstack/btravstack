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
  allowInsecureRequests,
  clientCredentialsGrant,
  discovery,
  type Configuration,
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
};

/**
 * How long before its stated expiry a token stops being handed out: it must
 * outlive the request it rides, through the callee's queue and a clock that
 * disagrees with this one. Capped at half a lifetime, so a short-lived token
 * is still reused.
 */
const SKEW_MS = 60_000;

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

const reasonOf = (audience: string, failure: FailureView<TokenError, unknown>): string =>
  failure.tag === "Err" && failure.error._tag === "TokenRefused"
    ? `${audience}: refused (${failure.error.error})`
    : `${audience}: the issuer could not be asked`;

const tokenFetches = (
  settings: Settings,
  observers: readonly Observer[],
  clock: Clock,
): Fetches => {
  let configuration: AsyncResult<Configuration, TokenIssuerUnavailable> | undefined;
  const cached = new Map<string, { readonly token: AccessToken; readonly refreshAt: number }>();
  const inFlight = new Map<string, AsyncResult<AccessToken, TokenError>>();
  const failing = new Map<string, string>();

  const discover = (): AsyncResult<Configuration, TokenIssuerUnavailable> => {
    configuration ??= fromPromise(
      discovery(
        new URL(settings.issuer),
        settings.clientId,
        undefined,
        ClientSecretBasic(settings.clientSecret),
        { execute: settings.insecure ? [allowInsecureRequests] : [] },
      ),
      (cause) => new TokenIssuerUnavailable({ issuer: settings.issuer, cause }),
    )
      .map((config) => {
        // The `execute` option does not reach the configuration it answers.
        if (settings.insecure) allowInsecureRequests(config);
        return config;
      })
      .tapFailure(() => {
        configuration = undefined;
      });
    return configuration;
  };

  const grant = (request: TokenRequest, config: Configuration) =>
    fromPromise(
      clientCredentialsGrant(config, {
        audience: request.audience,
        ...(request.scope === undefined ? {} : { scope: request.scope }),
      }),
      (cause): TokenError =>
        cause instanceof ResponseBodyError && cause.status < 500
          ? new TokenRefused({
              audience: request.audience,
              error: cause.error,
              description: cause.error_description,
            })
          : new TokenIssuerUnavailable({ issuer: settings.issuer, cause }),
    );

  const fetchToken = (key: string, request: TokenRequest): AsyncResult<AccessToken, TokenError> => {
    const asked = clock.now();
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
        failing.delete(key);
        cached.set(key, entry);
      })
      .tapFailure((failure) => {
        inFlight.delete(key);
        failing.set(key, reasonOf(request.audience, failure));
      })
      .map((entry) => entry.token);
    inFlight.set(key, fetched);
    return fetched;
  };

  return {
    source: {
      token: (request) => {
        const key = JSON.stringify([request.audience, request.scope ?? ""]);
        const hit = cached.get(key);
        if (hit !== undefined && clock.now() < hit.refreshAt) return OkAsync(hit.token);
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
 * The client credentials starter: `TokenSource` over an OAuth 2.0
 * authorization server, so a service calls another as itself.
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
 * - **A token is kept per audience and scope** until a minute before it
 *   expires (half its lifetime, if that is shorter), and callers asking for
 *   the same one while it is being fetched share that one request. A failure
 *   is never kept.
 * - **Every fetch is reported to `Observers`** (`component: "oauth-client"`);
 *   a token served from memory reports nothing.
 * - **It contributes the `oauth-client` health check**, failing while the
 *   last fetch of any audience failed — a rotated secret and an unreachable
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
          : OkAsync(tokenFetches({ ...bound, insecure }, observers, clock));
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
