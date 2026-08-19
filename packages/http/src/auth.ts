import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import {
  Port,
  Provider,
  type AnyPort,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";
import { ORPCError } from "@orpc/server";
import { ErrAsync, TaggedError, type AsyncResult } from "unthrown";

/**
 * Why a caller was refused. The reason is the **application's own**: the starter
 * does not surface it — a rejected caller gets an `UNAUTHORIZED` carrying oRPC's
 * default message and nothing else — so an authenticator that wants the reason
 * recorded logs it itself. Forwarding it would put "no such user" versus "bad
 * signature" in a 401 body by default.
 */
export class Unauthenticated extends TaggedError("Unauthenticated")<{
  readonly reason: string;
}> {}

/**
 * What an application provides so a marked procedure can name its caller.
 * Headers, not the request: an authenticator has no business reading a body,
 * and the narrower argument is what keeps it testable without a socket.
 */
export type AuthenticatorService<P> = (
  headers: IncomingHttpHeaders,
) => AsyncResult<P, Unauthenticated>;

/**
 * The authenticator's port — one id, the starter's own, like `HttpRouterPort`.
 * The service type is erased to `unknown` because di identifies a port by id;
 * the principal's type is carried by the provider `HttpAuthenticator` returns
 * and checked where the router and the authenticator meet.
 */
export const AuthenticatorPort = Port("HttpAuthenticator") as PortClassOf<
  "HttpAuthenticator",
  AuthenticatorService<unknown>
>;
export type AuthenticatorPort = PortInstance<"HttpAuthenticator", AuthenticatorService<unknown>>;

/**
 * The authenticator as a provider, with its principal type stated at the call:
 *
 * ```ts
 * export const jwtAuthenticator = HttpAuthenticator<Principal>()([JwtVerifier], {
 *   sync: (verify) => (headers) => verify(headers.authorization),
 * });
 * ```
 *
 * The type argument is explicit rather than inferred from `sync`: inference
 * through a returned function's `AsyncResult` is exactly where a `Principal`
 * silently widens to `unknown`, and the whole point is that it cannot.
 */
export const HttpAuthenticator =
  <P>() =>
  <const D extends readonly AnyPort[]>(
    deps: D,
    options: {
      readonly sync: (
        ...services: { [K in keyof D]: ServiceOf<InstanceType<D[K]>> }
      ) => AuthenticatorService<P>;
    },
  ): Provider<AuthenticatorPort, never, InstanceType<D[number]>> & { readonly principal: P } =>
    Provider(AuthenticatorPort)(deps, options as never) as never;

/**
 * What a marked leaf authenticates with when no authenticator reached the walk —
 * a state the two halves of the condition agreeing should make unreachable, and
 * the reason this exists is that a disagreement must fail **closed**: every
 * caller refused, rather than the leaf served unprotected.
 */
export const noAuthenticator: AuthenticatorService<never> = () =>
  ErrAsync(new Unauthenticated({ reason: "no authenticator" }));

/**
 * The one middleware this package installs, and only on a marked leaf. It reads
 * the request from oRPC's initial context — which is what initial context is
 * for — and either injects the principal or refuses.
 */
export const principalMiddleware =
  (authenticate: AuthenticatorService<unknown>) =>
  async (options: {
    readonly context: { readonly request: IncomingMessage };
    readonly next: (injected: {
      readonly context: { readonly principal: unknown };
    }) => Promise<unknown>;
  }): Promise<unknown> => {
    const resolved = await authenticate(options.context.request.headers);
    if (resolved.isErr()) {
      // The reason stays here: it is the application's, and oRPC serializes
      // `message` to the client.
      // oxlint-disable-next-line unthrown/no-throw -- oRPC terminates a request by throwing an ORPCError; its middleware protocol has no returned-error arm to use instead
      throw new ORPCError("UNAUTHORIZED");
    }
    if (resolved.isDefect()) {
      // A defect is a bug in the authenticator, not a refusal. Its own cause
      // goes up unchanged so oRPC's INTERNAL_SERVER_ERROR collapse answers it —
      // folding it into the 401 above would report a bug as a rejected caller.
      // oxlint-disable-next-line unthrown/no-throw -- the only way to hand a defect back to oRPC, whose middleware protocol has no returned-error arm
      throw resolved.cause;
    }
    return options.next({ context: { principal: resolved.value } });
  };
