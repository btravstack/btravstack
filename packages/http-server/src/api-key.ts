import { createHash, timingSafeEqual } from "node:crypto";

import { ErrAsync, OkAsync } from "unthrown";

import { HttpAuthenticator, Unauthenticated, granted, type Authenticator } from "./auth.js";

/** One issued key, and what presenting it makes the caller. */
export type ApiKey<P, Scope extends string> = {
  readonly key: string;
  readonly principal: P;
  /** What this key grants, checked against the endpoint's declared scopes by the existing 403 path. */
  readonly scopes?: readonly Scope[];
};

export type ApiKeyOptions<P, Scope extends string> = {
  /** Which header carries the key. Default `x-api-key`. */
  readonly header?: string;
  readonly keys: readonly ApiKey<P, Scope>[];
};

/** SHA-256 makes every comparison the same fixed width, which is what `timingSafeEqual` requires of its two buffers. */
const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * An API-key scheme, with the constant-time compare people get wrong.
 *
 * Three things it does that a hand-written one usually does not:
 *
 * - **It compares digests, not strings.** `===` on a secret leaks its prefix
 *   through timing, and `timingSafeEqual` refuses two buffers of different
 *   lengths — which would leak the key's LENGTH instead. Hashing first makes
 *   every comparison 32 bytes wide whatever was presented.
 * - **It checks every configured key, without an early return.** A loop that
 *   `break`s on the first match takes longer for a key configured late, which
 *   is a slower oracle but an oracle.
 * - **A missing header takes the same path as a wrong key**, so "no credential"
 *   and "bad credential" are not distinguishable by timing either. Both answer
 *   `Unauthenticated`, which the starter turns into `401`; the endpoint's own
 *   scope check is what produces a `403`.
 *
 * ```ts
 * export const serviceAuth = apiKeyAuthenticator<ServiceIdentity, "reports:read">({
 *   keys: [{ key: env.REPORTING_KEY, principal: { appId: "reporting" }, scopes: ["reports:read"] }],
 * });
 * ```
 *
 * Keys come from the caller — an `Env`-bound config field, a secret store —
 * because a key list in the image is a key list in the repository.
 */
export const apiKeyAuthenticator = <P, const Scope extends string = never>(
  options: ApiKeyOptions<P, Scope>,
): Authenticator<P, Scope, never> => {
  const header = (options.header ?? "x-api-key").toLowerCase();
  // Digested once, at composition: hashing every configured key on every
  // request would be the same work done per call for no extra secrecy.
  const issued = options.keys.map((entry) => ({ ...entry, digest: digest(entry.key) }));

  return HttpAuthenticator<P, Scope>()({
    inject: {},
    sync: () => (headers) => {
      const presented = headers[header];
      const candidate = digest(typeof presented === "string" ? presented : "");
      let matched: (typeof issued)[number] | undefined;
      for (const entry of issued) {
        // No `break`, and the assignment is unconditional work either way: the
        // loop costs the same whichever key matched, and the same again when
        // none did.
        if (timingSafeEqual(candidate, entry.digest)) matched = entry;
      }
      if (matched === undefined || typeof presented !== "string" || presented === "")
        return ErrAsync(new Unauthenticated());
      return OkAsync(
        (matched.scopes === undefined
          ? matched.principal
          : granted(matched.principal, matched.scopes)) as never,
      );
    },
  });
};
