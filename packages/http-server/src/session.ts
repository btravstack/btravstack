import { Config, ConfigInvalid, Env } from "@btravstack/config";
import { Port, Provider } from "@btravstack/di";
import { CompactEncrypt, compactDecrypt } from "jose";
import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";

/** What the cookie carries: the application's own principal, and when the session ends. */
export type Session<P> = {
  readonly principal: P;
  /**
   * The provider's session id, kept for logout; absent when the session was not
   * minted by an OIDC login.
   */
  readonly sid?: string;
  readonly iat: number;
  readonly exp: number;
};

export type SessionCodecService = {
  /**
   * Seals a session into a JWE. `iat` and `exp` are stamped here rather than
   * accepted, so a caller cannot mint a session that outlives the policy.
   */
  readonly seal: (session: Omit<Session<unknown>, "iat" | "exp">) => AsyncResult<string, never>;
  /**
   * The cookie's value, opened with whichever key still holds it. Every failure
   * — no cookie, not a JWE, a key that is gone, a tampered ciphertext, a session
   * past its `exp` — is the same `undefined`: an anonymous caller, never an
   * error and never a hint about which of those it was.
   */
  readonly unseal: (cookie: string | undefined) => AsyncResult<Session<unknown> | undefined, never>;
};

export class SessionCodec extends Port("HttpSessionCodec")<SessionCodecService> {}

/** Twelve hours, fixed: there is no sliding re-seal, so this is the whole session. */
export const DEFAULT_TTL_SEC = 43_200;

const KEY_BYTES = 32;

const HEADER = { alg: "dir", enc: "A256GCM" } as const;

// `Buffer.from` ignores what base64url cannot spell rather than refusing it, so
// the length of what came back is the only check worth making.
const decodeKey = (value: string): Uint8Array | undefined => {
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === KEY_BYTES ? new Uint8Array(bytes) : undefined;
};

const codec = (
  keys: readonly [Uint8Array, ...(readonly Uint8Array[])],
  ttlSec: number,
): SessionCodecService => {
  const [sealing] = keys;
  return {
    seal: ({ principal, sid }) => {
      const iat = Math.floor(Date.now() / 1000);
      // `JSON.stringify` drops an absent `sid`, so nothing spreads it in.
      const payload = JSON.stringify({ principal, sid, iat, exp: iat + ttlSec });
      return fromSafePromise(
        new CompactEncrypt(new TextEncoder().encode(payload))
          .setProtectedHeader(HEADER)
          .encrypt(sealing),
      );
    },
    unseal: (cookie) =>
      cookie === undefined
        ? OkAsync(undefined)
        : fromSafePromise(
            (async () => {
              const now = Math.floor(Date.now() / 1000);
              for (const key of keys) {
                const session = await compactDecrypt(cookie, key)
                  .then(
                    ({ plaintext }) =>
                      JSON.parse(new TextDecoder().decode(plaintext)) as Session<unknown>,
                  )
                  .catch(() => undefined);
                if (session !== undefined) return session.exp > now ? session : undefined;
              }
              return undefined;
            })(),
          ),
  };
};

/**
 * The cookie codec, from `HTTP_SESSION_KEYS` — a comma-separated list of
 * base64url 32-byte keys. The first seals, every one unseals, so rotation is
 * prepend, deploy, drop; a cookie sealed with a dropped key is anonymous rather
 * than an error.
 *
 * A key that is not 32 bytes is a `ConfigInvalid` naming the variable, at boot,
 * rather than a failure at the first request.
 */
export const sessionCodec = (
  pins: { readonly keys?: readonly string[]; readonly ttlSec?: number } = {},
): Provider<SessionCodec, ConfigInvalid, Env> & { readonly port: typeof SessionCodec } =>
  Provider(SessionCodec)({
    inject: { env: Env },
    make: ({ env }): AsyncResult<SessionCodecService, ConfigInvalid> =>
      Config.parse(
        "HttpSession",
        Config.object({
          keys: Config.pinned(pins.keys, Config.list("HTTP_SESSION_KEYS")),
        }),
      )(env).flatMap(({ keys }) => {
        const decoded = keys.map(decodeKey).filter((key) => key !== undefined);
        const [sealing, ...rotated] = decoded;
        return sealing === undefined || decoded.length !== keys.length
          ? ErrAsync(
              new ConfigInvalid({
                port: "HttpSession",
                issues: [
                  {
                    message: `must list base64url keys of ${KEY_BYTES} bytes`,
                    path: ["HTTP_SESSION_KEYS"],
                  },
                ],
              }),
            )
          : OkAsync(codec([sealing, ...rotated], pins.ttlSec ?? DEFAULT_TTL_SEC));
      }),
  });
