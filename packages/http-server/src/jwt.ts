import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ErrAsync, OkAsync, fromPromise } from "unthrown";

import {
  HttpAuthenticator,
  Unauthenticated,
  granted,
  type Authenticator,
  type AuthenticatorService,
} from "./auth.js";

/** The verified claims, as `jose` reports them. */
export type Claims = JWTPayload;

export type JwtOptions<P, Scopes extends readonly string[]> = {
  /**
   * The issuer's JWKS endpoint — pins `HTTP_JWT_JWKS_URI` when set, and is read
   * from it when not. Keys are fetched on demand and cached; a `kid` the cache
   * does not know triggers one refetch, rate-limited by `jose`.
   */
  readonly jwks?: string;
  /** Required `iss` — pins `HTTP_JWT_ISSUER`. A token from another issuer is refused. */
  readonly issuer?: string;
  /**
   * Required `aud` — pins `HTTP_JWT_AUDIENCE`. A token minted for another
   * audience is refused: this is the check that stops a token from a sibling
   * service being replayed here.
   */
  readonly audience?: string;
  /**
   * The signature algorithms this endpoint accepts. Default
   * {@link DEFAULT_ALGORITHMS} — asymmetric only, and `none` is not
   * expressible.
   */
  readonly algorithms?: readonly string[];
  /** Leeway on `exp`/`nbf`, in seconds. Default `0`. */
  readonly clockToleranceSec?: number;
  /** Which header carries the token. Default `authorization`, as `Bearer <token>`. */
  readonly header?: string;
  /**
   * What the claims make the caller. Answering `undefined` refuses the token —
   * the hook for a claim this endpoint requires and the standard does not, such
   * as a tenant.
   */
  readonly principal: (claims: Claims) => P | undefined;
  /**
   * The scopes this scheme can grant, and **the only place they are written**.
   * The scheme's vocabulary is inferred from this array rather than declared a
   * second time as a type argument, so it cannot be a superset of what the
   * scheme grants — a scope named in the type and missing from the array would
   * pass `ScopeGate` and then refuse every caller with a permanent 403.
   *
   * The granted list is the INTERSECTION of this vocabulary with what the token
   * carries, so a token claiming a scope the scheme does not know grants
   * nothing extra. Omit it entirely for a scheme with no scopes.
   */
  readonly scopes?: Scopes;
};

/**
 * Asymmetric only, and deliberately.
 *
 * `HS256` is absent because a JWKS endpoint publishes public keys: accepting an
 * HMAC algorithm alongside them is the **algorithm-confusion** attack, where an
 * attacker signs a token with the public key as the HMAC secret and the
 * verifier accepts it. `none` is not in the list and cannot be added — `jose`
 * refuses it — but the list is what makes that visible rather than implicit.
 */
export const DEFAULT_ALGORITHMS: readonly string[] = ["RS256", "RS384", "RS512", "ES256", "ES384"];

/** Space-delimited `scope` (RFC 8693) or an array `scp` (Entra, Okta) — both are in the wild, and neither is guaranteed. */
const claimedScopes = (claims: Claims): readonly string[] => {
  const scope = claims["scope"];
  if (typeof scope === "string") return scope.split(" ").filter((value) => value !== "");
  const scp = claims["scp"];
  if (Array.isArray(scp)) return scp.filter((value): value is string => typeof value === "string");
  return [];
};

const bearer = (value: string | readonly string[] | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const [scheme, token] = value.split(" ");
  return scheme?.toLowerCase() === "bearer" && token !== undefined && token !== ""
    ? token
    : undefined;
};

/**
 * A JWT scheme, verified against a remote JWKS.
 *
 * What it does that an application otherwise writes per deployment, which is
 * the reason this ships at all — writing it per application is how CVEs happen:
 *
 * - **JWKS fetch, cache and rotation.** `jose`'s `createRemoteJWKSet` fetches
 *   on demand, caches, and refetches when a token names a `kid` it has not
 *   seen — rate-limited, so an attacker cannot turn unknown `kid`s into a
 *   request amplifier against the issuer.
 * - **An algorithm allowlist that excludes HMAC.** See
 *   {@link DEFAULT_ALGORITHMS}: a JWKS publishes public keys, so accepting
 *   `HS256` beside them is the algorithm-confusion attack.
 * - **`iss`, `aud`, `exp` and `nbf`, all required.** `aud` in particular:
 *   without it a token minted for a sibling service is accepted here.
 *
 * Everything else is the application's, and stays a callback: `principal` says
 * what the claims mean, since no standard claim carries a tenant.
 *
 * ```ts
 * export const userAuth = jwtAuthenticator<Identity>()({
 *   scopes: ["orders:export"],
 *   principal: (claims) =>
 *     typeof claims["tenant"] === "string" && typeof claims.sub === "string"
 *       ? { tenantId: TenantId(claims["tenant"]), userId: claims.sub }
 *       : undefined,
 * });
 * ```
 *
 * `jwks`, `issuer` and `audience` are bound from `HTTP_JWT_JWKS_URI`,
 * `HTTP_JWT_ISSUER` and `HTTP_JWT_AUDIENCE`; an option PINS its variable, the
 * shape `http({ port })` has against `PORT`. A variable nobody pinned and
 * nobody set is a `ConfigInvalid` naming it, at startup.
 *
 * A refusal carries no reason, which is `Unauthenticated`'s own rule: an
 * authenticator that wants to record why logs it before returning.
 */
export const jwtAuthenticator =
  <P>() =>
  <const Scopes extends readonly string[] = readonly []>(
    options: JwtOptions<P, Scopes>,
  ): Authenticator<P, Scopes[number], Env, ConfigInvalid> => {
    const header = (options.header ?? "authorization").toLowerCase();
    const vocabulary = options.scopes;
    const schema = Config.object({
      jwks: Config.pinned(options.jwks, Config.url("HTTP_JWT_JWKS_URI")),
      issuer: Config.pinned(options.issuer, Config.string("HTTP_JWT_ISSUER")),
      audience: Config.pinned(options.audience, Config.string("HTTP_JWT_AUDIENCE")),
    });

    return HttpAuthenticator<P, Scopes[number]>()({
      inject: { env: Env },
      make: ({ env }) =>
        Config.parse(
          "HttpJwt",
          schema,
        )(env).map((bound): AuthenticatorService<P, Scopes[number]> => {
          // Built once, once the graph knows where the JWKS is: the key set IS
          // the cache, so one per request would refetch the issuer's keys on
          // every call.
          const keys = createRemoteJWKSet(new URL(bound.jwks));
          return (headers) => {
            const token = bearer(headers[header]);
            if (token === undefined) return ErrAsync(new Unauthenticated());
            return (
              fromPromise(
                jwtVerify(token, keys, {
                  issuer: bound.issuer,
                  audience: bound.audience,
                  algorithms: [...(options.algorithms ?? DEFAULT_ALGORITHMS)],
                  clockTolerance: options.clockToleranceSec ?? 0,
                  // `jose` validates `exp` only when it is PRESENT, so without
                  // this a signed token that omits it authenticates and never
                  // expires. `nbf` is deliberately not required: real issuers
                  // often omit it, and it is honoured when present either way.
                  requiredClaims: ["iss", "aud", "exp"],
                }),
                // Every failure is the same refusal: a signature that does not
                // verify, an expired token and an audience mismatch must not be
                // distinguishable from outside, or the endpoint becomes an
                // oracle for which of them the attacker got wrong.
                () => new Unauthenticated(),
              )
                .map(({ payload }) => payload)
                // `flatMap`, not `map`: `principal` answering `undefined` is a
                // REFUSAL, and mapping it would hand the handler `undefined` as
                // a principal — an unauthenticated caller with a context that
                // type-checks.
                .flatMap((claims) => {
                  const principal = options.principal(claims);
                  if (principal === undefined) return ErrAsync(new Unauthenticated());
                  if (vocabulary === undefined) return OkAsync(principal as never);
                  const held = new Set(claimedScopes(claims));
                  return OkAsync(
                    granted(
                      principal,
                      vocabulary.filter((scope) => held.has(scope)),
                    ) as never,
                  );
                })
            );
          };
        }),
    });
  };
