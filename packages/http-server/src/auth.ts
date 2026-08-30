import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import type { Requirements } from "@btravstack/contract";
import { Port, type AnyPort, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { ORPCError } from "@orpc/server";
import { Err, Ok, TaggedError, fromSafePromise, type AsyncResult, type Result } from "unthrown";

/**
 * A caller was refused. Carries nothing: the starter surfaces no reason — a
 * rejected caller gets an `UNAUTHORIZED` and oRPC's default message — so a
 * payload here would be write-only. An authenticator that wants to record why
 * logs it before returning this.
 */
export class Unauthenticated extends TaggedError("Unauthenticated") {}

/**
 * A credential was valid but granted none of the scopes the endpoint declared.
 * Distinct from {@link Unauthenticated} because the answers differ: an
 * anonymous caller gets `401`, an under-scoped one `403`.
 */
export class UnderScoped extends TaggedError("UnderScoped") {}

// Module-private, so `granted` is the only thing that mints a grant. The type
// parameter is erased at runtime, so structure is all the middleware has to go
// on — and `{ userId, tenantId, scopes }` is an ordinary JWT-claims identity, a
// BARE answer a `"scopes" in granted` test misread as the scoped one.
// `Symbol.for` rather than `Symbol()`: two copies of this package would
// otherwise read each other's grants as bare.
const GRANT: unique symbol = Symbol.for("@btravstack/http-server/grant") as never;

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

const ports = new Map<string, unknown>();

/**
 * One port per scheme, its id carrying the scheme name. The service type is
 * erased to `AuthenticatorService<unknown>`, since di identifies a port by id;
 * the principal and scope types ride the description `HttpAuthenticator`
 * returns.
 *
 * The id is a LITERAL type, so a contract naming a scheme the registry has no
 * authenticator for leaves that scheme's port unmet — di's own diagnostic,
 * naming the port, rather than a gate this package writes.
 *
 * Exported for the consumer `defineHttp` does not cover: a test substituting
 * ONE scheme's authenticator provides its own on this port instead of minting a
 * second registry.
 */
export const authenticatorPort = <const S extends string>(
  scheme: S,
): PortClassOf<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>> => {
  const id = `HttpAuthenticator:${scheme}` as const;
  // Memoised for the WARNING, not for resolution: two classes under one id are
  // the same type and the same lookup, but a second `Port(id)` call costs di's
  // duplicate-id warning — and binding here plus depending in `routerFor` is
  // the designed two-call pattern, not the declaration bug it exists to catch.
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
 * through a returned function's `AsyncResult` is where a principal silently
 * widens to `unknown`. The scheme NAME is not stated here — it is the key this
 * authenticator sits under in `defineHttp({ authenticators })`.
 */
export const HttpAuthenticator = <P, Scope extends string = never>() => {
  // Two arms discriminated by ARITY, mirroring `Provider(port)`'s own.
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
 * The authentication walk, protocol-neutral: requirements in the order the
 * contract declared them, first satisfied wins. Shared by every answerer, so a
 * scope check cannot drift between protocols.
 *
 * A defect from an authenticator is a bug in that authenticator, not a
 * refusal — it stays on the defect channel rather than falling through, which
 * would let a broken verifier silently promote every caller to the next scheme.
 */
export const resolvePrincipal = (
  requirements: Requirements,
  authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>,
  headers: IncomingHttpHeaders,
): AsyncResult<unknown, Unauthenticated | UnderScoped> =>
  fromSafePromise(walk(requirements, authenticators, headers)).flatMap((result) => result);

const walk = async (
  requirements: Requirements,
  authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>,
  headers: IncomingHttpHeaders,
  // oxlint-disable-next-line unthrown/prefer-async-result -- module-private; resolvePrincipal wraps it in fromSafePromise, which is the AsyncResult surface callers see
): Promise<Result<unknown, Unauthenticated | UnderScoped>> => {
  // More than one SCHEME, not more than one requirement: one requirement may
  // name several schemes, and counting requirements disagreed with `SchemesOf`,
  // so the handler typed `Tagged` while this injected bare.
  const tagged = new Set(requirements.flatMap((requirement) => Object.keys(requirement))).size > 1;
  let underScoped = false;
  for (const requirement of requirements) {
    for (const [scheme, required] of Object.entries(requirement)) {
      // Asserted, not guarded: the router declares one dep per scheme its
      // contract names, so di refuses the graph long before a request lands.
      const authenticate = authenticators[scheme] as AuthenticatorService<unknown>;
      const resolved = await authenticate(headers);
      // Returned rather than unwrapped: the defect channel survives the
      // `flatMap` above, so a broken authenticator reaches the caller as a
      // defect instead of a refusal.
      if (resolved.isDefect()) return resolved;
      if (resolved.isErr()) continue;
      const answer = resolved.value;
      // The BRAND, never a structural `"scopes" in answer` test, which misreads
      // a claims-shaped bare identity as the scoped answer.
      const scoped =
        typeof answer === "object" && answer !== null && GRANT in answer
          ? (answer as Grant<unknown, string>)
          : undefined;
      // A requirement naming scopes is NOT satisfied by a credential reporting
      // none. An empty `required` still passes trivially.
      const scopesGranted = scoped?.scopes ?? [];
      if (!required.every((scope) => scopesGranted.includes(scope))) {
        underScoped = true;
        continue;
      }
      const identity = scoped === undefined ? answer : scoped.identity;
      return Ok(tagged ? { scheme, identity } : identity);
    }
  }
  return Err(underScoped ? new UnderScoped() : new Unauthenticated());
};

/**
 * The one middleware this package installs, and only on a leaf whose
 * requirements say so — oRPC's adapter over {@link resolvePrincipal}. It reads
 * the request from oRPC's initial context, which is what initial context is for.
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
    const resolved = await resolvePrincipal(
      requirements,
      authenticators,
      options.context.request.headers,
    );
    if (resolved.isDefect()) {
      // oxlint-disable-next-line unthrown/no-throw -- the only way to hand a defect back to oRPC, whose middleware protocol has no returned-error arm
      throw resolved.cause;
    }
    if (resolved.isErr()) {
      // No message: oRPC serializes `message` to the client, and a refusal has
      // nothing a caller is entitled to.
      // oxlint-disable-next-line unthrown/no-throw -- oRPC terminates a request by throwing an ORPCError; its middleware protocol has no returned-error arm
      throw new ORPCError(resolved.error._tag === "UnderScoped" ? "FORBIDDEN" : "UNAUTHORIZED");
    }
    return await options.next({ context: { principal: resolved.value } });
  };
