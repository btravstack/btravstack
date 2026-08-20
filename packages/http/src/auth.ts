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
 * A caller was refused. Carries nothing: the starter surfaces no reason — a
 * rejected caller gets an `UNAUTHORIZED` and oRPC's default message — so a
 * payload here would be write-only. An authenticator that wants to record why
 * logs it before returning this.
 */
export class Unauthenticated extends TaggedError("Unauthenticated") {}

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
 * export const jwtAuthenticator = HttpAuthenticator<Principal>()({ verify: JwtVerifier }, {
 *   sync: ({ verify }) => (headers) => verify(headers.authorization),
 * });
 *
 * // An authenticator that reads nothing but the headers declares no deps:
 * export const bearerAuthenticator = HttpAuthenticator<Principal>()({
 *   sync: () => (headers) => principalOf(headers.authorization),
 * });
 * ```
 *
 * The type argument is explicit rather than inferred from `sync`: inference
 * through a returned function's `AsyncResult` is exactly where a `Principal`
 * silently widens to `unknown`, and the whole point is that it cannot.
 */
export const HttpAuthenticator = <P>() => {
  // Two arms, discriminated by ARITY, mirroring `Provider(port)`'s own — an
  // authenticator that reads only the request's headers declares no
  // dependencies, which is the common shape rather than an edge case.
  function build<const D extends Readonly<Record<string, AnyPort>>>(
    deps: D,
    options: {
      readonly sync: (services: {
        readonly [K in keyof D]: ServiceOf<InstanceType<D[K]>>;
      }) => AuthenticatorService<P>;
    },
  ): Provider<AuthenticatorPort, never, InstanceType<D[keyof D]>> & { readonly principal: P };
  function build(options: {
    readonly sync: () => AuthenticatorService<P>;
  }): Provider<AuthenticatorPort, never, never> & { readonly principal: P };
  function build(depsOrOptions: unknown, options?: unknown): unknown {
    return options === undefined
      ? Provider(AuthenticatorPort)(depsOrOptions as never)
      : Provider(AuthenticatorPort)(depsOrOptions as never, options as never);
  }
  return build;
};

/**
 * Unreachable today, and kept anyway. `routerOf` falls back to this when a
 * marked leaf has no authenticator behind it — which `HasMark<C>` and
 * `hasMarked` agreeing makes impossible, since a mark anywhere requires one.
 * It is two lines of insurance on a seam that has already failed twice, and it
 * fails **closed**: every caller refused, never a leaf served unprotected.
 * `auth.spec.ts` exercises it directly, because no router can reach it.
 */
export const noAuthenticator: AuthenticatorService<never> = () => ErrAsync(new Unauthenticated());

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
      // No message: oRPC serializes `message` to the client, and a refusal
      // has nothing a caller is entitled to.
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
