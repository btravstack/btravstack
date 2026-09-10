import { Config, ConfigInvalid, Env } from "@btravstack/config";
import { Port, Provider, type AnyProvider } from "@btravstack/di";
import { CompactEncrypt, compactDecrypt } from "jose";
import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";

import { HttpAuthenticator, Unauthenticated, granted, type Authenticator } from "./auth.js";

/**
 * What the cookie carries: the application's own principal, and when the
 * session ends.
 *
 * The sealed payload also holds a `typ` marker this type does not declare —
 * `seal` writes it and `unseal` requires it, so nothing outside this module
 * sets or reads one. A session put back on the wire whole would carry it;
 * send the principal, not the session.
 */
export type Session<P> = {
  readonly principal: P;
  /**
   * The provider's session id, kept for logout; absent when the session was not
   * minted by an OIDC login.
   */
  readonly sid?: string;
  /**
   * What the login recorded the session as holding. A scheme grants the
   * INTERSECTION of its own vocabulary with this, so a session naming a scope
   * the scheme does not know grants nothing extra.
   */
  readonly scopes?: readonly string[];
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
 */
export class CookieSchemes extends Port.many("HttpCookieSchemes")<boolean> {}

/** What `defineHttp` contributes for a scheme whose description says it reads a cookie. */
export const cookieScheme = (): AnyProvider =>
  Provider.member(CookieSchemes)({ inject: {}, value: true });

/** `csrf` unset is on exactly when a composed scheme reads a cookie. */
export const csrfOn = (option: boolean | undefined, schemes: readonly boolean[]): boolean =>
  option ?? schemes.some(Boolean);

/** Twelve hours, fixed: there is no sliding re-seal, so this is the whole session. */
export const DEFAULT_TTL_SEC = 43_200;

const KEY_BYTES = 32;

const HEADER = { alg: "dir", enc: "A256GCM" } as const;

// What this payload IS, written into the plaintext and required back. The
// algorithm pin refuses another algorithm under our key; this refuses another
// PURPOSE under our algorithm — the transient an OIDC login seals with these
// very keys, which a client is free to replay under the session cookie's name.
const TYP = "session";

// Decrypt only what this codec issues. Derived from `HEADER` so the two
// directions cannot drift apart.
const ALGORITHMS = {
  keyManagementAlgorithms: [HEADER.alg],
  contentEncryptionAlgorithms: [HEADER.enc],
};

// `Buffer.from` drops what base64url cannot spell rather than refusing it, so a
// typo that still decodes to 32 bytes is 32 DIFFERENT bytes — a boot that stays
// green and logs every session out. Re-encoding is what catches that, and the
// alphabet, and the padding.
const decodeKey = (value: string): Uint8Array | undefined => {
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === KEY_BYTES && bytes.toString("base64url") === value
    ? new Uint8Array(bytes)
    : undefined;
};

const scopesOf = (value: unknown): boolean =>
  Array.isArray(value) && value.every((scope) => typeof scope === "string");

// The plaintext is authenticated, not validated: a key this codec holds could
// have sealed anything, so what it is and what shape it has are both checked
// before it is trusted as a session — a `null` one used to defect on `.exp`, a
// string `exp` used to coerce its way past the lifetime, and a string `scopes`
// would defect on the `Set` a scheme builds from it.
const sessionOf = (plaintext: Uint8Array): Session<unknown> | undefined => {
  const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  return typeof decoded === "object" &&
    decoded !== null &&
    "typ" in decoded &&
    decoded.typ === TYP &&
    "principal" in decoded &&
    "iat" in decoded &&
    typeof decoded.iat === "number" &&
    "exp" in decoded &&
    typeof decoded.exp === "number" &&
    (!("sid" in decoded) || typeof decoded.sid === "string") &&
    (!("scopes" in decoded) || scopesOf(decoded.scopes))
    ? (decoded as Session<unknown>)
    : undefined;
};

const codec = (
  keys: readonly [Uint8Array, ...(readonly Uint8Array[])],
  ttlSec: number,
): SessionCodecService => {
  const [sealing] = keys;
  return {
    seal: ({ principal, sid, scopes }) =>
      // Serialised INSIDE the guard: `principal` is the application's own value,
      // so a cycle in it or a throwing `toJSON` is a Defect on the channel
      // rather than a throw at a call site whose type says it cannot.
      fromSafePromise(
        (async () => {
          const iat = Math.floor(Date.now() / 1000);
          // `JSON.stringify` drops an absent `sid`, so nothing spreads it in.
          const payload = JSON.stringify({
            typ: TYP,
            principal,
            sid,
            scopes,
            iat,
            exp: iat + ttlSec,
          });
          return await new CompactEncrypt(new TextEncoder().encode(payload))
            .setProtectedHeader(HEADER)
            .encrypt(sealing);
        })(),
      ),
    unseal: (cookie) =>
      cookie === undefined
        ? OkAsync(undefined)
        : fromSafePromise(
            (async () => {
              const now = Math.floor(Date.now() / 1000);
              for (const key of keys) {
                const session = await compactDecrypt(cookie, key, ALGORITHMS)
                  .then(({ plaintext }) => sessionOf(plaintext))
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
        const decoded = keys.map(decodeKey);
        // The POSITION, never the value: a key list is a secret, and "the
        // second one" is what an operator needs to fix it.
        const rejected = decoded.flatMap((key, at) => (key === undefined ? [at + 1] : []));
        const [sealing, ...rotated] = decoded.filter((key) => key !== undefined);
        return sealing === undefined || rejected.length > 0
          ? ErrAsync(
              new ConfigInvalid({
                port: "HttpSession",
                issues: [
                  {
                    message:
                      rejected.length > 0
                        ? `key ${rejected.join(", ")} of ${decoded.length} is not ${KEY_BYTES} base64url bytes (A-Z a-z 0-9 - _, no padding) — mint one with \`node -e 'console.log(require("node:crypto").randomBytes(${KEY_BYTES}).toString("base64url"))'\``
                        : `must list at least one ${KEY_BYTES}-byte base64url key`,
                    path: ["HTTP_SESSION_KEYS"],
                  },
                ],
              }),
            )
          : OkAsync(codec([sealing, ...rotated], pins.ttlSec ?? DEFAULT_TTL_SEC));
      }),
  });

const DEFAULT_COOKIE = "__Host-session";

/**
 * One cookie out of the `cookie` header, which `node:http` delivers as ONE
 * string. The name is matched EXACTLY, so `__Host-session-x` is not
 * `__Host-session`; only the first `=` splits, so a value carrying one arrives
 * whole; and the FIRST of a repeated name wins, which is the order a browser
 * sends them in — most specific first — so a later duplicate cannot shadow the
 * session.
 */
const cookieValue = (header: string | undefined, name: string): string | undefined => {
  for (const part of header?.split(";") ?? []) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
};

export type SessionOptions<P, Scopes extends readonly string[]> = {
  /**
   * The cookie the browser sends back. Default `__Host-session` — a
   * browser-enforced prefix: `Secure`, `Path=/`, no `Domain`, so a sibling
   * host cannot write it.
   */
  readonly cookie?: string;
  /**
   * The scopes this scheme can grant, and **the only place they are written**
   * — `jwtAuthenticator`'s rule, for `jwtAuthenticator`'s reason. The grant is
   * the INTERSECTION of this vocabulary with what the session carries. Omit it
   * entirely for a scheme with no scopes.
   */
  readonly scopes?: Scopes;
  /**
   * What the session makes the caller. Answering `undefined` refuses it — the
   * hook for a session this endpoint will not take, and the default's own
   * answer to a session sealed with no principal at all.
   */
  readonly principal?: (session: Session<unknown>) => P | undefined;
};

/**
 * The session-cookie scheme: a third one beside `jwtAuthenticator` and
 * `apiKeyAuthenticator`, so `requires: [{ session: [] }]` on a fragment route
 * and `authenticated({ session: [...] })` on a procedure need nothing new.
 *
 * ```ts
 * export const browserAuth = sessionAuthenticator<Identity>()({ scopes: ["orders:export"] });
 * ```
 *
 * It injects {@link SessionCodec} rather than holding keys of its own, so a
 * root composing this scheme without `sessionCodec()` is di's own unmet need
 * naming `SessionCodec` — and the codec that reads a cookie is the very one
 * that sealed it.
 *
 * No cookie, a cookie no key opens, a session past its `exp` and a principal
 * the application declined are ONE answer: `Unauthenticated`, carrying no
 * reason, which is the codec's own rule one layer up.
 */
export const sessionAuthenticator =
  <P>() =>
  <const Scopes extends readonly string[] = readonly []>(
    options: SessionOptions<P, Scopes> = {},
  ): Authenticator<P, Scopes[number], SessionCodec, never> => {
    const name = options.cookie ?? DEFAULT_COOKIE;
    // The vocabulary decides the answer's SHAPE, and it is read once here: a
    // scoped scheme answers an empty grant for a session that holds nothing,
    // never a bare identity.
    const vocabulary = options.scopes;
    const principalOf =
      options.principal ??
      // The codec cannot know `P`, so a payload sealed with `principal: null`
      // unseals happily; refusing it is this scheme's job.
      ((session: Session<unknown>) => (session.principal ?? undefined) as P | undefined);

    return {
      ...HttpAuthenticator<P, Scopes[number]>()({
        inject: { codec: SessionCodec },
        sync:
          ({ codec }) =>
          (headers) =>
            codec.unseal(cookieValue(headers.cookie, name)).flatMap((session) => {
              if (session === undefined) return ErrAsync(new Unauthenticated());
              const principal = principalOf(session);
              if (principal === undefined) return ErrAsync(new Unauthenticated());
              if (vocabulary === undefined) return OkAsync(principal as never);
              const held = new Set(session.scopes);
              return OkAsync(
                granted(
                  principal,
                  vocabulary.filter((scope) => held.has(scope)),
                ) as never,
              );
            }),
      }),
      cookie: true as const,
    };
  };
