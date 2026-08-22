import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import type { Requirements } from "@btravstack/contract";
import { Port, type AnyPort, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { ORPCError } from "@orpc/server";
import { TaggedError, type AsyncResult } from "unthrown";

/**
 * A caller was refused. Carries nothing: the starter surfaces no reason — a
 * rejected caller gets an `UNAUTHORIZED` and oRPC's default message — so a
 * payload here would be write-only. An authenticator that wants to record why
 * logs it before returning this.
 */
export class Unauthenticated extends TaggedError("Unauthenticated") {}

/**
 * What an authenticator hands back. A scheme with no scope vocabulary returns
 * the identity bare — byte-for-byte what applications write today — and one
 * with a vocabulary reports what the credential actually granted, so the
 * starter can compare it against what the endpoint declared.
 */
export type Granted<P, Scope extends string> = [Scope] extends [never]
  ? P
  : { readonly identity: P; readonly scopes: readonly Scope[] };

/**
 * Headers, not the request: an authenticator has no business reading a body,
 * and the narrower argument is what keeps it testable without a socket.
 */
export type AuthenticatorService<P, Scope extends string = never> = (
  headers: IncomingHttpHeaders,
) => AsyncResult<Granted<P, Scope>, Unauthenticated>;

const ports = new Map<string, unknown>();

/**
 * One port per scheme, its id carrying the scheme name — the move
 * `AmqpHandler(contract, key)` makes. The service type is erased to
 * `AuthenticatorService<unknown>` — `Granted<unknown, never>` is `unknown`, so
 * it admits the bare and the scoped answer alike — because di identifies a port
 * by id; the principal and scope types ride the description `HttpAuthenticator`
 * returns, and `defineHttp` reads the registry off them.
 *
 * The id is a LITERAL type, so `PortInstance<"HttpAuthenticator:user", …>` and
 * `PortInstance<"HttpAuthenticator:service", …>` are different types: a
 * contract naming a scheme the registry has no authenticator for leaves that
 * scheme's port unmet, which is di's own diagnostic naming the port rather than
 * a gate this package writes.
 */
export const authenticatorPort = <const S extends string>(
  scheme: S,
): PortClassOf<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>> => {
  const id = `HttpAuthenticator:${scheme}` as const;
  // Memoised: `defineHttp` asks for a scheme's port when it binds the
  // authenticator and `routerFor` asks again for every scheme its contract
  // names, and two `Port(id)` calls under one id are di's duplicate-id warning.
  const existing = ports.get(id);
  if (existing !== undefined) return existing as never;
  // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
  const minted = class extends Port(id)<AuthenticatorService<unknown>> {};
  ports.set(id, minted);
  return minted as never;
};

/**
 * What `HttpAuthenticator` hands back: a description `defineHttp` binds to a
 * port once the scheme name is known, carrying its principal and scope types
 * so the registry can be inferred rather than declared.
 */
export type Authenticator<P, Scope extends string, N> = {
  readonly deps: unknown;
  readonly options: unknown;
  readonly principal: P;
  readonly scope: Scope;
  readonly needs: N;
};

/**
 * The authenticator for one scheme, with its principal type — and the scopes it
 * can grant — stated at the call:
 *
 * ```ts
 * export const userAuth = HttpAuthenticator<Identity, "orders:export">()(
 *   { verify: JwtVerifier },
 *   { sync: ({ verify }) => (headers) => verify(headers.authorization) },
 * );
 *
 * // An authenticator that reads nothing but the headers declares no deps:
 * export const serviceAuth = HttpAuthenticator<ServiceIdentity>()({
 *   sync: () => (headers) => apiKey(headers["x-api-key"]),
 * });
 * ```
 *
 * The type arguments are explicit rather than inferred from `sync`: inference
 * through a returned function's `AsyncResult` is exactly where a principal
 * silently widens to `unknown`, and the whole point is that it cannot. The
 * scheme NAME is not stated here — it is the key this authenticator sits under
 * in `defineHttp({ authenticators })`, so it is written once.
 */
export const HttpAuthenticator = <P, Scope extends string = never>() => {
  // Two arms, discriminated by ARITY, mirroring `Provider(port)`'s own — an
  // authenticator that reads only the request's headers declares no
  // dependencies, which is the common shape rather than an edge case.
  function build<const D extends Readonly<Record<string, AnyPort>>>(
    deps: D,
    options: {
      readonly sync: (services: {
        readonly [K in keyof D]: ServiceOf<InstanceType<D[K]>>;
      }) => AuthenticatorService<P, Scope>;
    },
  ): Authenticator<P, Scope, InstanceType<D[keyof D]>>;
  function build(options: {
    readonly sync: () => AuthenticatorService<P, Scope>;
  }): Authenticator<P, Scope, never>;
  function build(depsOrOptions: unknown, options?: unknown): unknown {
    // The port is minted by `defineHttp`, which is the only place the scheme
    // NAME exists; this description is bound onto it there.
    return { deps: depsOrOptions, options };
  }
  return build;
};

/**
 * The one middleware this package installs, and only on a leaf whose
 * requirements say so. It reads the request from oRPC's initial context — which
 * is what initial context is for — and tries the requirements in the order the
 * contract declared them, taking the first a caller satisfies.
 */
export const principalMiddleware =
  (
    requirements: Requirements,
    authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>,
  ) =>
  async (options: {
    readonly context: { readonly request: IncomingMessage };
    readonly next: (injected: {
      readonly context: { readonly principal: unknown };
    }) => Promise<unknown>;
  }): Promise<unknown> => {
    // Tagged only when the leaf names more than one scheme: the single-scheme
    // form is what applications already write, and paying a wrapper for it
    // would make the common case worse to serve the rare one.
    const tagged = requirements.length > 1;
    let underScoped = false;
    for (const requirement of requirements) {
      for (const [scheme, required] of Object.entries(requirement)) {
        // Asserted, not guarded: the router declares one dep per scheme its
        // contract names, so every scheme a requirement names is a key here and
        // di refuses the graph long before a request lands.
        const authenticate = authenticators[scheme] as AuthenticatorService<unknown>;
        const resolved = await authenticate(options.context.request.headers);
        if (resolved.isDefect()) {
          // A defect is a bug in the authenticator, not a refusal. Falling
          // through would let a broken verifier silently promote every caller
          // to the next scheme.
          // oxlint-disable-next-line unthrown/no-throw -- the only way to hand a defect back to oRPC, whose middleware protocol has no returned-error arm
          throw resolved.cause;
        }
        if (resolved.isErr()) continue;
        // `Granted` is erased to `unknown` on the port, because a scheme with a
        // vocabulary answers `{ identity, scopes }` and one without answers the
        // identity bare — so which it is has to be read back structurally.
        const granted = resolved.value;
        const scoped =
          typeof granted === "object" && granted !== null && "scopes" in granted
            ? (granted as { readonly identity: unknown; readonly scopes: readonly string[] })
            : undefined;
        if (scoped !== undefined && !required.every((scope) => scoped.scopes.includes(scope))) {
          underScoped = true;
          continue;
        }
        const identity = scoped === undefined ? granted : scoped.identity;
        return await options.next({
          context: { principal: tagged ? { scheme, identity } : identity },
        });
      }
    }
    // No message: oRPC serializes `message` to the client, and a refusal has
    // nothing a caller is entitled to. A credential that was valid but
    // under-scoped is a 403, never the 401 an anonymous caller gets.
    // oxlint-disable-next-line unthrown/no-throw -- oRPC terminates a request by throwing an ORPCError; its middleware protocol has no returned-error arm to use instead
    throw new ORPCError(underScoped ? "FORBIDDEN" : "UNAUTHORIZED");
  };
