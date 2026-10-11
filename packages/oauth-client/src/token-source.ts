import { Port, Provider } from "@btravstack/di";
import { OkAsync, TaggedError, type AsyncResult } from "unthrown";

/**
 * What a token is asked for: the service it will be presented to, and
 * optionally the scopes it must carry (space-delimited, as OAuth spells them).
 *
 * A record rather than positional arguments, so a later field — the actor a
 * call is made on behalf of — joins it without moving anything already here.
 */
export type TokenRequest = {
  /** The callee, as its authorization server names it: the `aud` the token is minted for. */
  readonly audience: string;
  readonly scope?: string;
};

/**
 * A token to present, as `Authorization: Bearer <bearer>`.
 *
 * No expiry rides it: keeping a token until shortly before it expires is the
 * source's job, and a caller that held the expiry would be a caller about to
 * cache it a second time.
 */
export type AccessToken = {
  readonly bearer: string;
};

/**
 * The authorization server answered, and the answer was no — an OAuth error
 * (`invalid_client`, `invalid_scope`, `invalid_request`, `unauthorized_client`…).
 * A configuration or a registration is wrong, so asking again will not help.
 *
 * It carries the server's `error` code and description, and never the client
 * secret.
 */
export class TokenRefused extends TaggedError("TokenRefused")<{
  readonly audience: string;
  readonly error: string;
  readonly description: string | undefined;
}> {}

/**
 * The authorization server could not be asked: discovery failed, the network
 * did, or it answered with a server error. Transient, so a later call asks
 * again — a failure is never cached.
 */
export class TokenIssuerUnavailable extends TaggedError("TokenIssuerUnavailable")<{
  readonly issuer: string;
  readonly cause: unknown;
}> {}

export type TokenSourceService = {
  readonly token: (
    request: TokenRequest,
  ) => AsyncResult<AccessToken, TokenRefused | TokenIssuerUnavailable>;
};

/**
 * The port an application depends on to call another service as itself: a
 * bearer token for an audience. `oauthClient()` provides it over the client
 * credentials grant; `staticTokenSource` is the in-process stand-in.
 */
export class TokenSource extends Port("TokenSource")<TokenSourceService> {}

/**
 * The in-process adapter: the same `bearer` for every request, and it cannot
 * fail. The shape `@btravstack/testing`'s `overridden` takes, so a spec swaps
 * the real source under the real root.
 */
export const staticTokenSource = (bearer: string) =>
  Provider(TokenSource)({ inject: {}, value: { token: () => OkAsync({ bearer }) } });
