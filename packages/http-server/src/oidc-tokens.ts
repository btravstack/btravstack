import { randomBytes } from "node:crypto";

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
  Observers,
  observed,
  systemClock,
  type Clock,
  type Operation,
  type Settle,
} from "@btravstack/core";
import { Provider, type PortClassOf } from "@btravstack/di";
import {
  ClientError,
  ResponseBodyError,
  WWWAuthenticateChallengeError,
  refreshTokenGrant,
  type Configuration,
} from "openid-client";
import { ErrAsync, OkAsync, TaggedError, fromPromise, type AsyncResult } from "unthrown";

import { Unauthenticated } from "./auth.js";
import { discoverOidc, type OidcUnreachable } from "./oidc-discovery.js";
import {
  OidcTokenStore,
  OidcTokens,
  type OidcTokenStoreUnavailable,
  type OidcTokenResponse,
  type OidcTokensService,
  type OidcTokenStoreService,
  type OidcTokenUpdate,
  type StoredOidcTokens,
} from "./oidc-token-store.js";
import type { PrefixOf } from "./options.js";
import { SessionCodec, type SessionCodecService } from "./session.js";

export { OidcTokenStore, OidcTokenStoreUnavailable, OidcTokens } from "./oidc-token-store.js";
export type {
  OidcTokenResponse,
  OidcTokensService,
  OidcTokenStoreService,
  OidcTokenUpdate,
  StoredOidcTokens,
} from "./oidc-token-store.js";

/** One token manager's deployment configuration. `port` names a second login's capability. */
export type OidcTokensOptions = {
  readonly issuer?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly variablePrefix?: string;
  readonly port?: PortClassOf<string, OidcTokensService>;
  readonly allowInsecureIssuer?: boolean;
  readonly clock?: Clock;
};

type TokensPort<O> = O extends {
  readonly port: infer P extends PortClassOf<string, OidcTokensService>;
}
  ? P
  : O extends { readonly port?: infer P }
    ? Extract<P, PortClassOf<string, OidcTokensService>> | typeof OidcTokens
    : typeof OidcTokens;
type TokenEnvironment<O> = EnvReading<
  | Unpinned<O, "issuer", `${PrefixOf<O, "HTTP_OIDC">}_ISSUER`>
  | Unpinned<O, "clientId", `${PrefixOf<O, "HTTP_OIDC">}_CLIENT_ID`>
  | Unpinned<O, "clientSecret", `${PrefixOf<O, "HTTP_OIDC">}_CLIENT_SECRET`>,
  | MaybePinned<O, "issuer", `${PrefixOf<O, "HTTP_OIDC">}_ISSUER`>
  | MaybePinned<O, "clientId", `${PrefixOf<O, "HTTP_OIDC">}_CLIENT_ID`>
  | MaybePinned<O, "clientSecret", `${PrefixOf<O, "HTTP_OIDC">}_CLIENT_SECRET`>
>;

/**
 * Bind a server-only token manager to a shared store and the existing session
 * codec. Discovery runs once per manager. Compose this beside `oidc({ tokens:
 * provider.port })` and `sessionAuthenticator({ tokens: provider.port })`.
 */
export const oidcTokens = <const O extends OidcTokensOptions = Record<never, never>>(
  options: O & OptionsAs<O, OidcTokensOptions> = {} as never,
): Provider<
  InstanceType<TokensPort<O>>,
  ConfigInvalid | OidcUnreachable,
  TokenEnvironment<O> | OidcTokenStore | SessionCodec | Observers
> & { readonly port: TokensPort<O> } => {
  const variables = options.variablePrefix ?? "HTTP_OIDC";
  const schema = Config.object({
    issuer: Config.pinned(options.issuer, Config.url(`${variables}_ISSUER`)),
    clientId: Config.pinned(options.clientId, Config.string(`${variables}_CLIENT_ID`)),
    clientSecret: Config.pinned(options.clientSecret, Config.string(`${variables}_CLIENT_SECRET`)),
  });
  return Provider(options.port ?? OidcTokens)({
    inject: { env: Env, codec: SessionCodec, store: OidcTokenStore, observers: Observers },
    make: ({ env, codec, store, observers }) =>
      Config.parse(
        "HttpOidcTokens",
        schema,
      )(env).flatMap(
        (settings): AsyncResult<OidcTokensService, ConfigInvalid | OidcUnreachable> => {
          const insecure = cleartext(settings.issuer, options.allowInsecureIssuer ?? false);
          if (insecure === "refused")
            return ErrAsync(
              cleartextRefused({
                port: "HttpOidcTokens",
                variable: `${variables}_ISSUER`,
                option: "allowInsecureIssuer",
                on: "oidcTokens()",
                what: "it sends the client secret and every token in the open",
              }),
            );
          return discoverOidc(
            settings.issuer,
            settings.clientId,
            settings.clientSecret,
            insecure,
          ).map((configuration) =>
            createOidcTokens(
              configuration,
              codec,
              store,
              observers,
              options.clock ?? systemClock,
              settings,
            ),
          );
        },
      ),
  }) as never;
};

/**
 * Framework-neutral factory over already-discovered client configuration. The
 * binding must name that client's issuer and client ID. No HTTP listener is needed.
 */
export const createOidcTokens = (
  configuration: Configuration,
  codec: SessionCodecService,
  store: OidcTokenStoreService,
  observers: readonly ((operation: Operation) => Settle)[],
  clock: Clock,
  binding: { readonly issuer: string; readonly clientId: string },
): OidcTokensService => {
  const operation = <T, E>(name: string, call: () => AsyncResult<T, E>): AsyncResult<T, E> =>
    observed(observers, { component: "oidc-tokens", name, attributes: {} }, call, {
      failure: (failure) => ({ outcome: "error", attributes: { reason: failure.tag } }),
    });
  const owns = (record: StoredOidcTokens | undefined): record is StoredOidcTokens =>
    record !== undefined &&
    record.issuer === binding.issuer &&
    record.clientId === binding.clientId;
  const live = (record: StoredOidcTokens | undefined): record is StoredOidcTokens =>
    owns(record) && record.sessionExpiresAt > clock.now();
  const opened = (cookie: string | undefined) =>
    codec
      .unseal(cookie)
      .map((session) =>
        session?.iss === binding.issuer &&
        session.clientId === binding.clientId &&
        session.tokenRef !== undefined
          ? { ...session, tokenRef: session.tokenRef }
          : undefined,
      );
  const service: OidcTokensService = {
    ...binding,
    create: (session, subject, tokens) =>
      operation<string, Unauthenticated | OidcTokenStoreUnavailable>("create", () => {
        const record = stored(tokens, clock.now(), {
          ...binding,
          subject,
          sessionExpiresAt: clock.now() + codec.ttlSec * SECOND_MS,
        });
        if (
          session.iss !== binding.issuer ||
          session.clientId !== binding.clientId ||
          subject === "" ||
          record === undefined
        )
          return ErrAsync(new Unauthenticated());
        const tokenRef = randomBytes(REFERENCE_BYTES).toString("base64url");
        return codec.seal({ ...session, tokenRef }).flatTap(() => store.create(tokenRef, record));
      }),
    session: (cookie) =>
      operation("session", () =>
        opened(cookie).flatMap((session) => {
          if (session === undefined) return OkAsync(undefined);
          return store.transact(session.tokenRef, (record) =>
            OkAsync({
              record:
                record !== undefined && record.sessionExpiresAt > clock.now() ? record : undefined,
              value: live(record) ? session : undefined,
            }),
          );
        }),
      ),
    accessToken: (cookie) =>
      operation("access", () =>
        opened(cookie).flatMap((session) => {
          if (session === undefined) return ErrAsync(new Unauthenticated());
          return store
            .transact(
              session.tokenRef,
              (record): AsyncResult<OidcTokenUpdate<string | undefined>, never> => {
                if (!owns(record)) return OkAsync({ record, value: undefined });
                if (!live(record)) return OkAsync({ record: undefined, value: undefined });
                if (record.refreshAfter > clock.now())
                  return OkAsync({ record, value: record.accessToken });
                const refreshToken = record.refreshToken;
                if (refreshToken === undefined)
                  return OkAsync({ record: undefined, value: undefined });
                const requestedAt = clock.now();
                return operation("refresh", () =>
                  fromPromise(refreshTokenGrant(configuration, refreshToken), (cause, defect) =>
                    cause instanceof ClientError ||
                    cause instanceof ResponseBodyError ||
                    cause instanceof WWWAuthenticateChallengeError ||
                    cause instanceof TypeError ||
                    cause instanceof DOMException
                      ? new RefreshFailed()
                      : defect(cause),
                  ).flatMap((response) => {
                    const subject = response.claims()?.sub;
                    const next = stored(response, requestedAt, record);
                    if (
                      next === undefined ||
                      next.accessExpiresAt <= clock.now() ||
                      next.sessionExpiresAt <= clock.now() ||
                      (subject !== undefined && subject !== record.subject)
                    )
                      return ErrAsync(new RefreshFailed());
                    return OkAsync({ record: next, value: next.accessToken });
                  }),
                ).recoverErrCases((matcher) =>
                  matcher.with({ _tag: "OidcRefreshFailed" }, () => ({
                    record: undefined,
                    value: undefined,
                  })),
                );
              },
            )
            .flatMap((token) =>
              token === undefined ? ErrAsync(new Unauthenticated()) : OkAsync(token),
            );
        }),
      ),
    invalidate: (cookie) =>
      operation("invalidate", () =>
        opened(cookie).flatMap((session) =>
          session === undefined
            ? OkAsync()
            : store.transact(session.tokenRef, (record) =>
                OkAsync({ record: owns(record) ? undefined : record, value: undefined }),
              ),
        ),
      ),
  };
  return service;
};

const SECOND_MS = 1000;
const REFERENCE_BYTES = 32;
const REFRESH_SKEW_MS = 30_000;
class RefreshFailed extends TaggedError("OidcRefreshFailed") {}

function stored(
  response: OidcTokenResponse,
  issuedAt: number,
  previous: Pick<StoredOidcTokens, "issuer" | "clientId" | "subject" | "sessionExpiresAt"> & {
    readonly refreshToken?: string;
  },
): StoredOidcTokens | undefined {
  const lifetime = response.expires_in;
  if (
    response.token_type.toLowerCase() !== "bearer" ||
    response.access_token === "" ||
    lifetime === undefined ||
    !Number.isSafeInteger(lifetime) ||
    lifetime <= 0
  )
    return undefined;
  const duration = lifetime * SECOND_MS;
  if (!Number.isSafeInteger(issuedAt + duration)) return undefined;
  return {
    issuer: previous.issuer,
    clientId: previous.clientId,
    subject: previous.subject,
    sessionExpiresAt: previous.sessionExpiresAt,
    accessToken: response.access_token,
    ...((response.refresh_token ?? previous.refreshToken) === undefined
      ? {}
      : { refreshToken: response.refresh_token ?? previous.refreshToken }),
    accessExpiresAt: issuedAt + duration,
    refreshAfter: issuedAt + duration - Math.min(REFRESH_SKEW_MS, duration / 2),
  };
}
