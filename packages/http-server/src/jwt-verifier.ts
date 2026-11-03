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
import { Observers, observe } from "@btravstack/core";
import { Port, Provider, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { Err, ErrAsync, Ok, fromPromise, type AsyncResult } from "unthrown";

import { AuthenticatorUnavailable, CredentialRefused } from "./auth.js";
import type { PrefixOf } from "./options.js";

/** The verified claims, as `jose` reports them. */
export type Claims = JWTPayload;

/** Asymmetric signature algorithms accepted unless the composition pins another allowlist. */
export const DEFAULT_ALGORITHMS: readonly string[] = ["RS256", "RS384", "RS512", "ES256", "ES384"];

/** A verifier checks one deployment-owned issuer against an explicit expected recipient. */
export type JwtVerifierService = {
  readonly verify: (input: {
    readonly token: string;
    readonly audience: string;
  }) => AsyncResult<Claims, CredentialRefused | AuthenticatorUnavailable>;
};

/** Verified signed evidence, independently of the credential authenticating an HTTP request. */
export class JwtVerifier extends Port("JwtVerifier")<JwtVerifierService> {}

/** Issuer trust is fixed at composition/startup; the expected audience is supplied per verification. */
export type JwtVerifierOptions = {
  /** Pins `<variablePrefix>_JWKS_URI`; fetched keys are cached across audiences. */
  readonly jwks?: string;
  /** Pins the required `iss` instead of reading `<variablePrefix>_ISSUER`. */
  readonly issuer?: string;
  /** Prefix of the issuer and JWKS variables. Default `HTTP_JWT`. */
  readonly variablePrefix?: string;
  /** Accepted signatures. Default {@link DEFAULT_ALGORITHMS}. */
  readonly algorithms?: readonly string[];
  /** Leeway on `exp` and `nbf`, in seconds. Default `0`. */
  readonly clockToleranceSec?: number;
  /** Opt in to non-loopback cleartext JWKS transport. Default `false`. */
  readonly allowInsecureJwks?: boolean;
  /** A separate port for a second configured issuer. Default {@link JwtVerifier}. */
  readonly port?: PortClassOf<string, JwtVerifierService>;
};

/**
 * Bind a cached JWT verifier without registering an HTTP authentication scheme.
 * The caller must derive the expected audience from trusted application policy,
 * never from the evidence token's unverified claims. Blank audiences are refused.
 */
export const jwtVerifier = <const O extends JwtVerifierOptions = Record<never, never>>(
  options: O & OptionsAs<O, JwtVerifierOptions> = {} as never,
): Provider<InstanceType<VerifierPort<O>>, ConfigInvalid, VerifierEnvironment<O> | Observers> & {
  readonly port: VerifierPort<O>;
} => {
  const prefix = options.variablePrefix ?? "HTTP_JWT";
  const schema = Config.object({
    jwks: Config.pinned(options.jwks, Config.url(`${prefix}_JWKS_URI`)),
    issuer: Config.pinned(options.issuer, Config.string(`${prefix}_ISSUER`)),
  });
  return Provider(options.port ?? JwtVerifier)({
    inject: { env: Env, observers: Observers },
    make: ({ env, observers }) =>
      Config.parse(
        "JwtVerifier",
        schema,
      )(env).flatMap((bound) => {
        if (cleartext(bound.jwks, options.allowInsecureJwks ?? false) === "refused") {
          return Err(
            cleartextRefused({
              port: "JwtVerifier",
              variable: `${prefix}_JWKS_URI`,
              option: "allowInsecureJwks",
              on: "jwtVerifier()",
              what: "anything on the path can substitute its own signing key and mint tokens this process accepts",
            }),
          );
        }
        return Ok(remoteJwtVerifier(bound, options, observers));
      }),
  }) as never;
};

export function remoteJwtVerifier(
  settings: { readonly jwks: string; readonly issuer: string },
  options: Pick<JwtVerifierOptions, "algorithms" | "clockToleranceSec">,
  observers: ServiceOf<Observers>,
): JwtVerifierService {
  const keys = createRemoteJWKSet(new URL(settings.jwks));
  return {
    verify: ({ token, audience }) => {
      if (audience.trim() === "") return ErrAsync(new CredentialRefused());
      return fromPromise(
        jwtVerify(token, keys, {
          issuer: settings.issuer,
          audience,
          algorithms: [...(options.algorithms ?? DEFAULT_ALGORITHMS)],
          clockTolerance: options.clockToleranceSec ?? 0,
          requiredClaims: ["iss", "aud", "exp"],
        }),
        (cause) => {
          const reason = keySetReason(cause, token, keys);
          if (reason === undefined) return new CredentialRefused();
          observe(observers, { component: "jwt", name: "verify", attributes: {} })({
            outcome: "error",
            attributes: { reason },
            cause,
          });
          return new AuthenticatorUnavailable();
        },
      ).map(({ payload }) => payload);
    },
  };
}

type VerifierPort<O> = O extends {
  readonly port: infer P extends PortClassOf<string, JwtVerifierService>;
}
  ? P
  : O extends { readonly port?: infer P }
    ? Extract<P, PortClassOf<string, JwtVerifierService>> | typeof JwtVerifier
    : typeof JwtVerifier;

type VerifierEnvironment<O> = EnvReading<
  | Unpinned<O, "jwks", `${PrefixOf<O, "HTTP_JWT">}_JWKS_URI`>
  | Unpinned<O, "issuer", `${PrefixOf<O, "HTTP_JWT">}_ISSUER`>,
  | MaybePinned<O, "jwks", `${PrefixOf<O, "HTTP_JWT">}_JWKS_URI`>
  | MaybePinned<O, "issuer", `${PrefixOf<O, "HTTP_JWT">}_ISSUER`>
>;

// No key matching the token's `kid` and `alg` is the token's fault, not the issuer's,
// unless the issuer publishes that `kid` with metadata no verification can use.
const KEY_SET_REASONS: Readonly<Record<string, string>> = {
  ERR_JWKS_TIMEOUT: "keys_unreachable",
  ERR_JWKS_INVALID: "keys_invalid",
  ERR_JWK_INVALID: "key_invalid",
  ERR_JOSE_GENERIC: "issuer_unreachable",
};

function keySetReason(
  cause: unknown,
  token: string,
  keys: ReturnType<typeof createRemoteJWKSet>,
): string | undefined {
  const code: unknown = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return "issuer_unreachable";
  if (code === "ERR_JWKS_NO_MATCHING_KEY")
    return publishesUnusableKey(token, keys) ? "key_unusable" : undefined;
  return KEY_SET_REASONS[code];
}

function publishesUnusableKey(token: string, keys: ReturnType<typeof createRemoteJWKSet>): boolean {
  const { kid } = decodeProtectedHeader(token);
  return (
    kid !== undefined &&
    (keys.jwks()?.keys ?? []).some((jwk) => jwk.kid === kid && !verifiable(jwk))
  );
}

// The checks `jose` applies to a key before any `alg` comparison: a key failing one is
// unusable for every token, so it is the issuer's fault.
function verifiable(jwk: {
  readonly ext?: unknown;
  readonly use?: unknown;
  readonly key_ops?: unknown;
}): boolean {
  const ops = jwk.key_ops;
  return (
    (jwk.ext === undefined || typeof jwk.ext === "boolean") &&
    (jwk.use === undefined || jwk.use === "sig") &&
    (ops === undefined ||
      (Array.isArray(ops) &&
        ops.includes("verify") &&
        ops.every(
          (operation, index) => typeof operation === "string" && ops.indexOf(operation) === index,
        )))
  );
}
