import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

import type { Unauthenticated } from "./auth.js";
import type { Session } from "./session.js";

/** A storage failure, without credentials or driver diagnostics. */
export class OidcTokenStoreUnavailable extends TaggedError("OidcTokenStoreUnavailable") {}

/** Server-only credentials. Adapters must protect these at rest and expire the row at `sessionExpiresAt`. */
export type StoredOidcTokens = {
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accessExpiresAt: number;
  readonly refreshAfter: number;
  readonly sessionExpiresAt: number;
};

/** An atomic replacement. `undefined` deletes the record, and `value` is returned to the caller. */
export type OidcTokenUpdate<T> = {
  readonly record: StoredOidcTokens | undefined;
  readonly value: T;
};

/**
 * Application-supplied shared storage. `create` must refuse an existing reference.
 * `transact` holds exclusive ownership across ALL replicas until `work` settles and
 * its replacement commits. Missing records must be locked too; deletion, refresh
 * and invalidation use this same boundary. A defect commits nothing. A lease that
 * expires must fence the old writer rather than allow it to recreate a deleted row.
 */
export type OidcTokenStoreService = {
  readonly create: (
    reference: string,
    record: StoredOidcTokens,
  ) => AsyncResult<void, OidcTokenStoreUnavailable>;
  readonly transact: <T>(
    reference: string,
    work: (record: StoredOidcTokens | undefined) => AsyncResult<OidcTokenUpdate<T>, never>,
  ) => AsyncResult<T, OidcTokenStoreUnavailable>;
};

/** Server-side OIDC credentials; no in-process production adapter is supplied. */
export class OidcTokenStore extends Port("HttpOidcTokenStore")<OidcTokenStoreService> {}

/** The token endpoint fields retained by the server; ID tokens are never persisted. */
export type OidcTokenResponse = {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
};

/**
 * One login's server-only capability. Framework adapters pass the raw
 * `__Host-session` cookie, never a reference supplied in a URL or form.
 * `session` validates revocation without refreshing; `accessToken` refreshes under
 * the store's shared lock. `invalidate` deletes before returning success.
 */
export type OidcTokensService = {
  readonly issuer: string;
  readonly clientId: string;
  readonly create: (
    session: Omit<Session<unknown>, "iat" | "exp" | "tokenRef">,
    subject: string,
    tokens: OidcTokenResponse,
  ) => AsyncResult<string, Unauthenticated | OidcTokenStoreUnavailable>;
  readonly session: (
    cookie: string | undefined,
  ) => AsyncResult<Session<unknown> | undefined, OidcTokenStoreUnavailable>;
  readonly accessToken: (
    cookie: string | undefined,
  ) => AsyncResult<string, Unauthenticated | OidcTokenStoreUnavailable>;
  readonly invalidate: (cookie: string | undefined) => AsyncResult<void, OidcTokenStoreUnavailable>;
};

/** The default delegated-login capability; another login may declare its own port of the same type. */
export class OidcTokens extends Port("HttpOidcTokens")<OidcTokensService> {}
