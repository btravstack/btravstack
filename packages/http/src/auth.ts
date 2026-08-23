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

// Module-private, so the mark cannot be applied by accident: `Grant` is the
// only shape carrying it and `granted` the only thing that mints one. The type
// parameter is erased at runtime, so structure is all the middleware has to go
// on — and `{ userId, tenantId, scopes }` is an ordinary JWT-claims identity, a
// BARE answer that a `"scopes" in granted` test read as the scoped one and
// destroyed. `Symbol.for` rather than `Symbol()`: two copies of this package
// would otherwise read each other's grants as bare.
const GRANT: unique symbol = Symbol.for("@btravstack/http/grant") as never;

/**
 * The scoped answer, and the reason `granted()` is mandatory rather than
 * advisory: the brand is what tells it from an identity that merely happens to
 * carry a `scopes` field.
 */
export type Grant<P, Scope extends string> = {
  readonly identity: P;
  readonly scopes: readonly Scope[];
  readonly [GRANT]: true;
};

/**
 * What an authenticator hands back. A scheme with no scope vocabulary returns
 * the identity bare — byte-for-byte what applications write today — and one
 * with a vocabulary reports what the credential actually granted, so the
 * starter can compare it against what the endpoint declared.
 */
export type Granted<P, Scope extends string> = [Scope] extends [never] ? P : Grant<P, Scope>;

/**
 * What a scoped scheme answers with:
 *
 * ```ts
 * OkAsync(granted({ userId }, ["orders:export"]));
 * ```
 *
 * `Scope` is not inferred from the vocabulary — an empty grant would collapse
 * it to `never` and take the return type back to the bare arm — so the array is
 * what states it, checked against the vocabulary by the assignment.
 */
export const granted = <P, const Scope extends string = never>(
  identity: P,
  scopes: readonly Scope[],
): Grant<P, Scope> => ({ identity, scopes, [GRANT]: true });

/**
 * Headers, not the request: an authenticator has no business reading a body,
 * and the narrower argument is what keeps it testable without a socket.
 */
export type AuthenticatorService<P, Scope extends string = never> = (
  headers: IncomingHttpHeaders,
) => AsyncResult<Granted<P, Scope>, Unauthenticated>;

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
 *
 * Exported for the consumer `defineHttp` does not cover: a test composition
 * substituting ONE scheme's authenticator provides its own on this port —
 * `Provider(authenticatorPort("user"))({ value: stub })` — instead of minting
 * a second registry. No in-repo example does; the examples are scenarios, not
 * the library's one user.
 */
export const authenticatorPort = <const S extends string>(
  scheme: S,
): PortClassOf<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>> => {
  // Not memoised: di identifies a port by its `portId` string and the instance
  // type is branded by the id literal, so two classes minted under one id are
  // the same type and the same lookup — `defineHttp` binding and `routerFor`
  // depending resolve to one provider either way (measured: the suite passes
  // with a fresh class per call).
  // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
  return class extends Port(`HttpAuthenticator:${scheme}`)<
    AuthenticatorService<unknown>
  > {} as never;
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
    // Tagged when the leaf names more than one SCHEME, not more than one
    // requirement. One requirement may name several schemes, and counting
    // requirements disagreed with `SchemesOf`, which unions the scheme names
    // across all of them: the handler typed `Tagged` while this injected bare,
    // so `principal.scheme` read `undefined` with no type error to catch it.
    const tagged =
      new Set(requirements.flatMap((requirement) => Object.keys(requirement))).size > 1;
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
        // `Granted` is erased to `unknown` on the port, so which arm answered
        // has to be read back at runtime. The BRAND is what says so — a
        // structural `"scopes" in answer` test misreads a claims-shaped bare
        // identity as the scoped answer and hands the handler `undefined`.
        const answer = resolved.value;
        const scoped =
          typeof answer === "object" && answer !== null && GRANT in answer
            ? (answer as Grant<unknown, string>)
            : undefined;
        // A requirement that names scopes is NOT satisfied by a credential
        // reporting none. A scheme declared without a vocabulary answers bare,
        // and skipping the comparison for it admitted the caller outright —
        // the one place in this package where the failure direction matters.
        // An empty `required` still passes trivially.
        const scopesGranted = scoped?.scopes ?? [];
        if (!required.every((scope) => scopesGranted.includes(scope))) {
          underScoped = true;
          continue;
        }
        const identity = scoped === undefined ? answer : scoped.identity;
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
