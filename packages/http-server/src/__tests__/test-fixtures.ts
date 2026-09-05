import type { IncomingHttpHeaders, Server } from "node:http";

import { vi } from "vitest";

/**
 * Capture the real `http.Server` instances the runtime creates, so the
 * error-listener tests can assert on the server itself without exposing it
 * through the shipped `Serving` type just for a test.
 */
export const capturedServers: Server[] = [];
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      capturedServers.push(server);
      return server;
    },
  };
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

import type { ConfigInvalid, Environment } from "@btravstack/config";
import { authenticated } from "@btravstack/contract";
import {
  Observers,
  currentUnit,
  noObserver,
  type Attributes,
  type Operation,
  type RunningApp,
  type Settle,
} from "@btravstack/core";
import { Module, Port, Provider, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { bootFixture, type Boot } from "@btravstack/testing";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { eventIterator, oc, type as ocType, type RouterContractClient } from "@orpc/contract";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ErrAsync, OkAsync, type AsyncResult } from "unthrown";
import { test } from "vitest";
import { z } from "zod";

import { apiKeyAuthenticator } from "../api-key.js";
import {
  HttpAuthenticator,
  Unauthenticated,
  authenticatorPort,
  granted,
  type Authenticator,
  type AuthenticatorService,
  type Grant,
} from "../auth.js";
import { defineHttp } from "../define-http.js";
import { HttpHandler, type HttpAnswerer } from "../handler.js";
import { html } from "../html.js";
import { HtmxFragmentsPort } from "../htmx-route.js";
import { htmx } from "../htmx.js";
import { HttpConfig } from "../http-config.js";
import { HttpModule } from "../http-module.js";
import {
  HttpRuntime,
  HttpUnit,
  _internal_httpRuntime,
  http,
  httpServer,
  type HttpInfo,
  type HttpOptions,
} from "../http-runtime.js";
import { jwtAuthenticator } from "../jwt.js";

/** What a bare answerer's `handle` is, without the mount point around it. */
type Handler = HttpAnswerer["handle"];

/** That handler as the one answerer of a graph, mounted at the root. */
const answering = (handle: Handler, prefix: `/${string}` = "/") =>
  Provider.member(HttpHandler)({ inject: {}, value: { prefix, handle } });

/** Everything the unmarked fixtures below mint: no authenticators, no schemes. */
const publicApi = defineHttp();

/**
 * The transport under test with a bare listener where `http()` would put the
 * oRPC one, so the guarantees are exercised without a router in the way.
 */
const appOf = (handler: Handler, port = 0, securityHeaders?: HttpOptions["securityHeaders"]) =>
  Module("App")({
    imports: [
      httpServer({
        port,
        hostname: "127.0.0.1",
        ...(securityHeaders === undefined ? {} : { securityHeaders }),
      }),
    ],
    provides: [answering(handler)],
    exports: [HttpRuntime, HttpHandler],
  });

/**
 * The runtime over a hand-provided `HttpConfig`, bypassing `Config` entirely —
 * the one route left to a port `listen` refuses synchronously, now that
 * `Config.port`'s own rule catches an out-of-range pin at graph build. A
 * consumer binding `HttpConfig` itself is the case that still reaches
 * `ERR_SOCKET_BAD_PORT`, and the guard exists so it arrives as a modeled
 * `RuntimeStartFailed` rather than a defect.
 */
const appOnUncheckedPort = (port: number) =>
  Module("AppOnUncheckedPort")({
    provides: [
      Provider(HttpConfig)({
        inject: {},
        value: { port, hostname: "127.0.0.1", bodyLimit: 0, corsOrigin: "", compression: false },
      }),
      Provider.member(Observers)({ inject: {}, value: noObserver }),
      Provider(HttpRuntime)({
        inject: { config: HttpConfig, observers: Observers },
        sync: ({ config, observers }) => _internal_httpRuntime(config, undefined, observers),
      }),
      answering(noop),
    ],
    exports: [HttpRuntime, HttpHandler],
  });

/** One observed operation, as an observer saw it settle. */
export type Observation = {
  readonly component: string;
  readonly name: string;
  readonly attributes: Attributes;
  readonly outcome: "ok" | "error";
};

/**
 * An observer that keeps what it was handed, so a spec asserts on the
 * DIMENSIONS rather than on a vendor's exporter — and on the fact that the
 * finisher ran, which is what tells a recorded operation from a started one.
 */
const recordingObserver = (): {
  member: (operation: Operation) => Settle;
  taken: () => readonly Observation[];
} => {
  const taken: Observation[] = [];
  return {
    member:
      ({ component, name, attributes }) =>
      ({ outcome, attributes: settled }) => {
        taken.push({ component, name, attributes: { ...attributes, ...settled }, outcome });
      },
    taken: () => taken,
  };
};

/**
 * The transport over an observer that records — the composition a deployment
 * gets by composing any observability at all, since the runtime asks for no
 * ports to be observable.
 */
const observedAppOf = (handler: Handler, member: (operation: Operation) => Settle) =>
  Module("ObservedApp")({
    imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
    // Mounted at `/rpc`, not `/`: a path OUTSIDE it is what reaches the
    // runtime's own 404, which is the half of RED an answerer never sees.
    provides: [
      answering(handler, "/rpc"),
      Provider.member(Observers)({ inject: {}, value: member }),
    ],
    exports: [HttpRuntime, HttpHandler],
  });

/**
 * The `AuthenticatorService` inside a description, without a graph.
 *
 * `Authenticator` erases `options` to `unknown` on purpose — `defineHttp` is
 * what binds it to a port — so a unit test of an authenticator has to reach
 * through that erasure. It is the one cast here, and it is the shape
 * `defineHttp` itself reads.
 */
const serviceOf = <P, Scope extends string>(
  authenticator: Authenticator<P, Scope, never>,
): AuthenticatorService<P, Scope> =>
  (
    authenticator.options as {
      readonly sync: (services: Record<never, never>) => AuthenticatorService<P, Scope>;
    }
  ).sync({});

/**
 * A local issuer: one generated key pair, its JWKS on an ephemeral port, and a
 * signer. A real fetch against a real JWKS document is what makes the rotation
 * and caching under test the library's own rather than a double's.
 */
const issuerOf = async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const { privateKey: otherPrivate } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;

  return {
    jwks: `http://127.0.0.1:${port}/jwks.json`,
    issuer: "https://issuer.test",
    audience: "orders-api",
    /** A token this issuer signed, with whatever claims and overrides a test needs. */
    sign: (
      claims: Record<string, unknown> = {},
      overrides: { issuer?: string; audience?: string; expiresIn?: string } = {},
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(overrides.issuer ?? "https://issuer.test")
        .setAudience(overrides.audience ?? "orders-api")
        .setIssuedAt()
        .setExpirationTime(overrides.expiresIn ?? "5m")
        .sign(privateKey),
    /** A properly signed token carrying no `exp` — valid forever unless the verifier requires the claim. */
    signWithoutExpiry: () =>
      new SignJWT({ sub: "u-1", tenant: "acme" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer("https://issuer.test")
        .setAudience("orders-api")
        .setIssuedAt()
        .sign(privateKey),
    /** A token signed by a key this issuer's JWKS does not publish. */
    signWithStranger: (claims: Record<string, unknown> = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer("https://issuer.test")
        .setAudience("orders-api")
        .setExpirationTime("5m")
        .sign(otherPrivate),
    /**
     * The algorithm-confusion attack's own payload: `HS256` signed with the
     * PUBLISHED public key as the shared secret — the very JWK this issuer
     * serves, which is what makes it an attack anyone can mount rather than one
     * needing a key they do not have.
     */
    signHmacWithPublicKey: () =>
      new SignJWT({ sub: "u-1", tenant: "acme" })
        .setProtectedHeader({ alg: "HS256", kid: "k1" })
        .setIssuer("https://issuer.test")
        .setAudience("orders-api")
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode(JSON.stringify(jwk))),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
};

/** What both shipped authenticators resolve to in these specs. */
export type ServiceIdentity = { readonly appId: string };
export type JwtIdentity = { readonly tenantId: string; readonly userId: string };

/** Two issued keys, one scoped and one not, so a spec can tell which key answered. */
const apiKeys = apiKeyAuthenticator<ServiceIdentity>()({
  keys: [
    { key: "first-secret", principal: { appId: "reporting" }, scopes: ["reports:read"] },
    { key: "second-secret", principal: { appId: "billing" }, scopes: [] },
  ],
});

/** A scheme with no scope vocabulary, on a header of its own — where `scopes` is not expressible. */
const bareApiKey = apiKeyAuthenticator<ServiceIdentity>()({
  header: "x-service-key",
  keys: [{ key: "plain-secret", principal: { appId: "plain" } }],
});

const jwtPrincipal = (claims: { sub?: string; [key: string]: unknown }): JwtIdentity | undefined =>
  typeof claims["tenant"] === "string" && typeof claims.sub === "string"
    ? { tenantId: claims["tenant"], userId: claims.sub }
    : undefined;

/** A greeting service, so the router has a real dependency to declare. */
class Greeter extends Port("Greeter")<{ readonly greet: (name: string) => string }> {}

/** Three bare procedures, one nested — the contract is what types the implementation below and the client. */
const helloFragment = { hello: oc };
const nestedFragment = { ping: oc };
const greetingContract = oc.router({ ...helloFragment, boom: oc, nested: nestedFragment });

const greetingImplementation = (greeter: ServiceOf<Greeter>) => ({
  hello: () => OkAsync(greeter.greet("world")),
  boom: () => {
    // oxlint-disable-next-line unthrown/no-throw -- the defect IS the subject under test: oRPC's own collapse to INTERNAL_SERVER_ERROR
    throw new Error("bug");
  },
  nested: { ping: () => OkAsync("pong") },
});

/** The router as a service, built from the greeter it declares — contract-first, on the starter's own router port. */
const greetingRouter = publicApi.OrpcRouter(greetingContract)({
  inject: { greeter: Greeter },
  sync: ({ greeter }) => greetingImplementation(greeter),
});

/** A one-route fragment answerer, so `scoped` can prove htmx forks the same way oRPC does. */
const scopedFragment = publicApi.HtmxGet("/frag")({
  inject: {},
  sync: () => () => OkAsync(html`ok`),
});
const scopedFragmentsProvider = publicApi.HtmxFragments([scopedFragment]);

/** The composing form's own contract, so the two arms are exercised side by side. */
const slicedContract = oc.router({ greetings: helloFragment, echoes: nestedFragment });

/**
 * Two pieces over `slicedContract` — the path is the port's name. The second is
 * minted by a DOTTED path, so the composing arm's `nest` rebuild is exercised
 * on a real request rather than only on top-level keys.
 */
export const helloController = publicApi.OrpcController(
  slicedContract,
  "greetings",
)({
  inject: { greeter: Greeter },
  sync: ({ greeter }) => ({ hello: () => OkAsync(greeter.greet("world")) }),
});

const echoesController = publicApi.OrpcController(
  slicedContract,
  "echoes.ping",
)({ inject: {}, sync: () => () => OkAsync("pong") });

/**
 * A router declaring no dependencies, whose `sync` records what it was handed.
 * `inject: {}` still yields one services record — empty — which an arrow
 * ignores and a rest parameter sees.
 */
const noDepsRouterRecording = () => {
  let seen: readonly unknown[] = [];
  const provider = publicApi.OrpcRouter(oc.router({ greetings: helloFragment }))({
    inject: {},
    sync: ((...args: readonly unknown[]) => {
      seen = args;
      return { greetings: { hello: () => OkAsync("hello world") } };
    }) as never,
  });
  return { provider, handed: () => seen };
};

/** The same kind of API as `greetingRouter`, composed from pieces instead of one `sync`. */
const slicedRouter = publicApi.OrpcRouter(slicedContract)([helloController, echoesController]);

/** `HttpModule` over the composed router, mirroring `rpcAppOf`. */
const rpcSlicedAppOf = () =>
  HttpModule("RpcSlicedApp")({
    router: slicedRouter,
    port: 0,
    hostname: "127.0.0.1",
    provides: [
      helloController,
      echoesController,
      Provider(Greeter)({ inject: {}, value: { greet: (name) => `hello ${name}` } }),
    ],
  });

/**
 * Two pieces sharing the nested parent "v1" — "v1.orders" and "v1.customers" —
 * plus one minted at the bare PROCEDURE path "health". The shared parent forces
 * `nest`'s node-reuse branch (`node[segment] ??= {}` finding a node the first
 * piece already created) to actually run, which `slicedContract`'s one dotted
 * piece above never exercises; "health" is the depth-N leaf case, a piece with
 * no fragment around it at all.
 */
const deepContract = {
  v1: { orders: { place: oc }, customers: { find: oc } },
  health: oc,
};

const v1OrdersController = publicApi.OrpcController(
  deepContract,
  "v1.orders",
)({ inject: {}, sync: () => ({ place: () => OkAsync({ id: "o-1" }) }) });
const v1CustomersController = publicApi.OrpcController(
  deepContract,
  "v1.customers",
)({ inject: {}, sync: () => ({ find: () => OkAsync({ id: "c-1" }) }) });
const deepHealthController = publicApi.OrpcController(
  deepContract,
  "health",
)({ inject: {}, sync: () => () => OkAsync({ ok: true as const }) });

const deepRouter = publicApi.OrpcRouter(deepContract)([
  v1OrdersController,
  v1CustomersController,
  deepHealthController,
]);

const rpcDeepAppOf = () =>
  HttpModule("RpcDeepApp")({
    router: deepRouter,
    port: 0,
    hostname: "127.0.0.1",
    provides: [v1OrdersController, v1CustomersController, deepHealthController],
  });

/** What this deployment knows about a caller; `defineHttp` is the only place one is stated. */
type Identity = { readonly tenantId: string; readonly userId: string };

const userAuthenticator = HttpAuthenticator<Identity>()({
  inject: {},
  sync: () => (headers) => {
    if (headers.authorization === "Bearer boom") {
      return OkAsync().map((): Identity => {
        // oxlint-disable-next-line unthrown/no-throw -- an authenticator bug IS the subject under test, and a throw inside a combinator is the only way to mint a Defect
        throw new Error("authenticator bug");
      });
    }
    return headers.authorization === "Bearer good"
      ? OkAsync({ tenantId: "t-good", userId: "u-good" })
      : ErrAsync(new Unauthenticated());
  },
});

/** One scheme, `user` — the registry every marked fixture below is typed by. */
const api = defineHttp({ authenticators: { user: userAuthenticator } });

/** One protected fragment and one public one — the marker's runtime half, end to end. */
const whoami = oc
  .input(ocType<{ readonly id: string }>())
  .output(ocType<{ readonly userId: string }>());
const ping = oc.output(ocType<{ readonly ok: true }>());
const authedContract = { orders: authenticated({ user: [] })({ whoami }), health: { ping } };

/** Counted so a test can assert the handler was never entered on a refusal. */
let authedRuns = 0;

const authedOrdersController = api.OrpcController(
  authedContract,
  "orders",
)({
  inject: {},
  sync: () => ({
    whoami: ({ context }) => {
      authedRuns += 1;
      return OkAsync({ userId: context.principal.userId });
    },
  }),
});

const authedHealthController = api.OrpcController(
  authedContract,
  "health",
)({ inject: {}, sync: () => ({ ping: () => OkAsync({ ok: true as const }) }) });

const authedRouter = api.OrpcRouter(authedContract)([
  authedOrdersController,
  authedHealthController,
]);

/**
 * The same marked contract through the whole-router form, so the scheme's own
 * key on the `inject` record is pinned.
 */
const authedWholeRouter = api.OrpcRouter(authedContract)({
  inject: { greeter: Greeter },
  sync: ({ greeter }) => ({
    orders: {
      whoami: ({ context }) => OkAsync({ userId: greeter.greet(context.principal.userId) }),
    },
    health: { ping: () => OkAsync({ ok: true as const }) },
  }),
});

/** `HttpModule` over the protected router; the authenticator rides in with it. */
const rpcAuthedAppOf = () =>
  HttpModule("RpcAuthedApp")({
    router: authedRouter,
    port: 0,
    hostname: "127.0.0.1",
    provides: [authedOrdersController, authedHealthController],
  });

/**
 * The marker on the contract's ROOT, where the walk has no `contract[key]` to
 * read it from: every leaf inherits it, the same way `Implementation<C>`'s
 * record arm inherits the enclosing requirements.
 */
const rootMarkedContract = authenticated({ user: [] })({ orders: { whoami } });

let rootMarkedRuns = 0;

const rootMarkedRouter = api.OrpcRouter(rootMarkedContract)({
  inject: {},
  sync: () => ({
    orders: {
      whoami: ({ context }) => {
        rootMarkedRuns += 1;
        return OkAsync({ userId: context.principal.userId });
      },
    },
  }),
});

const rpcRootMarkedAppOf = () =>
  HttpModule("RpcRootMarkedApp")({
    router: rootMarkedRouter,
    port: 0,
    hostname: "127.0.0.1",
  });

/**
 * The marker on the ROOT, served through a piece minted TWO LEVELS below it —
 * `FragmentAt`'s compile-time fold happens at the piece's own mint, while
 * `routerOf`'s runtime walk is seeded from the ROUTER's contract regardless of
 * how many pieces compose it; this is the one fixture where both are live at
 * once, so a disagreement between them would surface here as an auth bypass.
 */
const rootMarkedDeepContract = authenticated({ user: [] })({ v1: { orders: { whoami } } });

let rootMarkedDeepRuns = 0;

const rootMarkedDeepController = api.OrpcController(
  rootMarkedDeepContract,
  "v1.orders",
)({
  inject: {},
  sync: () => ({
    whoami: ({ context }) => {
      rootMarkedDeepRuns += 1;
      return OkAsync({ userId: context.principal.userId });
    },
  }),
});

const rootMarkedDeepRouter = api.OrpcRouter(rootMarkedDeepContract)([rootMarkedDeepController]);

const rpcRootMarkedDeepAppOf = () =>
  HttpModule("RpcRootMarkedDeepApp")({
    router: rootMarkedDeepRouter,
    port: 0,
    hostname: "127.0.0.1",
    provides: [rootMarkedDeepController],
  });

/** The other arm of `HttpAuthenticator`: one that DECLARES a dependency. */
class TokenTable extends Port("TokenTable")<(token: string) => Identity | undefined> {}

const verifying = defineHttp({
  authenticators: {
    user: HttpAuthenticator<Identity>()({
      inject: { tokens: TokenTable },
      sync:
        ({ tokens }) =>
        (headers) => {
          const claimed = tokens(headers.authorization ?? "");
          return claimed === undefined ? ErrAsync(new Unauthenticated()) : OkAsync(claimed);
        },
    }),
  },
});

const verifiedRouter = verifying.OrpcRouter({
  orders: authenticated({ user: [] })({ whoami }),
})({
  inject: {},
  sync: () => ({
    orders: { whoami: ({ context }) => OkAsync({ userId: context.principal.userId }) },
  }),
});

const rpcVerifiedAppOf = () =>
  HttpModule("RpcVerifiedApp")({
    router: verifiedRouter,
    port: 0,
    hostname: "127.0.0.1",
    imports: [
      Module("Tokens")({
        provides: [
          Provider(TokenTable)({
            inject: {},
            value: (token) =>
              token === "Bearer keyed" ? { tenantId: "t-keyed", userId: "u-keyed" } : undefined,
          }),
        ],
        exports: [TokenTable],
      }),
    ],
  });

/**
 * The substitution seam `authenticatorPort` exists for: a hand-rolled
 * composition provides its OWN authenticator on the scheme's port and never
 * spreads `router.authenticators`. The `TokenTable`-backed one is not in this
 * graph at all, which is the point — the stub composition never builds it.
 */
const rpcSubstitutedAppOf = () =>
  Module("RpcSubstitutedApp")({
    imports: [http({ port: 0, hostname: "127.0.0.1" })],
    provides: [
      verifiedRouter,
      Provider(authenticatorPort("user"))({
        inject: {},
        value: () => OkAsync({ userId: "u-stub" }),
      }),
    ],
    exports: [HttpRuntime, HttpHandler],
  });

class KindedAnonSpan extends Port("KindedAnonSpan")<{ readonly at: number }> {}
class KindedUserSpan extends Port("KindedUserSpan")<{ readonly at: number }> {}

/** Derived from the seeded principal — what a leaf reads back off `context.unit`. */
class KindedUserId extends Port("KindedUserId")<string> {}

/**
 * The two kinds' modules, counting builds and stops, the `user` one recording
 * the principal the fork seeded it with — the observable that tells "forked the
 * right kind" from "forked at all". Fresh per call, so counts start at zero.
 */
const kindedUnitsOf = <
  P extends PortClassOf<`HttpPrincipal:${string}`, { readonly userId: string }>,
>(
  principal: P,
) => {
  const counts = {
    anonymous: { builds: 0, stops: 0 },
    user: { builds: 0, stops: 0 },
  };
  const seen: unknown[] = [];
  const anonymous = Module("KindedAnonUnit")({
    provides: [
      Provider(KindedAnonSpan)({
        inject: {},
        sync: () => {
          counts.anonymous.builds += 1;
          return { at: counts.anonymous.builds };
        },
        onStop: () => {
          counts.anonymous.stops += 1;
        },
      }),
    ],
    exports: [KindedAnonSpan],
  });
  const user = Module("KindedUserUnit")({
    needs: [principal],
    provides: [
      Provider(KindedUserSpan)({
        inject: { principal },
        sync: ({ principal: injected }) => {
          counts.user.builds += 1;
          seen.push(injected);
          return { at: counts.user.builds };
        },
        onStop: () => {
          counts.user.stops += 1;
        },
      }),
      Provider(KindedUserId)({
        inject: { principal },
        sync: ({ principal: injected }) => injected.userId,
      }),
    ],
    exports: [KindedUserSpan, KindedUserId],
  });
  return { anonymous, user, counts: () => counts, seen: () => seen };
};

type KindedUnits = ReturnType<typeof kindedUnitsOf>;

/** The same scheme registry, retyped by the kinds it binds — what types `context.unit`. */
const kindedApi = api.units<{
  anonymous: KindedUnits["anonymous"];
  user: KindedUnits["user"];
}>();

/**
 * The pair that reads the fork back: a MARKED leaf declaring a port only the
 * `user` kind's module exports, beside a piece declaring no record at all. Two
 * pieces, so the array arm's nearest-piece lookup is what finds each leaf's.
 */
const unitOrdersController = kindedApi.OrpcController(
  authedContract,
  "orders",
)({
  inject: {},
  unit: { userId: KindedUserId },
  sync: () => ({ whoami: ({ context }) => OkAsync({ userId: context.unit.userId }) }),
});

const unitHealthController = kindedApi.OrpcController(
  authedContract,
  "health",
)({ inject: {}, sync: () => ({ ping: () => OkAsync({ ok: true as const }) }) });

const unitRouter = kindedApi.OrpcRouter(authedContract)([
  unitOrdersController,
  unitHealthController,
]);

/** `Bearer ${token}`, or no credentials at all when `token` is `undefined`. */
const linkOf = (origin: string, token: string | undefined) =>
  new RPCLink({
    origin,
    url: "/rpc",
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

/** The marker is erased from the client's view — it is a phantom key, never a procedure. */
type AuthedClient = RouterContractClient<{
  readonly orders: { readonly whoami: typeof whoami };
  readonly health: { readonly ping: typeof ping };
}>;

/** Builds and stops, per kind. */
type KindCounts = ReturnType<ReturnType<typeof kindedUnitsOf>["counts"]>;

type RootMarkedClient = RouterContractClient<{
  readonly orders: { readonly whoami: typeof whoami };
}>;

type RootMarkedDeepClient = RouterContractClient<{
  readonly v1: { readonly orders: { readonly whoami: typeof whoami } };
}>;

type DeepClient = RouterContractClient<typeof deepContract>;

/**
 * The same implementation carrying a key the contract never declared, reachable
 * only past the types: `routerOf` drops it rather than defecting on it.
 */
const strayRouter = publicApi.OrpcRouter(greetingContract)({
  inject: { greeter: Greeter },
  sync: ({ greeter }) =>
    ({ ...greetingImplementation(greeter), stray: () => OkAsync("stray") }) as ReturnType<
      typeof greetingImplementation
    >,
});

/** The starter as an application uses it: `HttpModule` sugar over a router provider. */
const rpcAppOf = (prefix?: `/${string}`, stray = false) =>
  HttpModule("RpcApp")({
    router: stray ? strayRouter : greetingRouter,
    port: 0,
    hostname: "127.0.0.1",
    ...(prefix === undefined ? {} : { prefix }),
    provides: [Provider(Greeter)({ inject: {}, value: { greet: (name) => `hello ${name}` } })],
  });

/**
 * An unrelated router and fragments, composed by ONE `HttpModule` call — a
 * proof that a root can serve both protocols from one runtime on one port.
 * Public and minimal on purpose: the gate under test is the composition, not
 * either protocol's own behaviour, which the rest of this file already
 * covers.
 */
const bothContract = oc.router({ ping: oc.output(ocType<string>()) });
const bothRouter = publicApi.OrpcRouter(bothContract)({
  inject: {},
  sync: () => ({ ping: () => OkAsync("pong") }),
});

const bothStatusFragment = publicApi.HtmxGet("/status")({
  inject: {},
  sync: () => () => OkAsync(html`<p>ok</p>`),
});
const bothFragmentsProvider = publicApi.HtmxFragments([bothStatusFragment]);

const bothProtocolsAppOf = () =>
  HttpModule("BothProtocolsApp")({
    router: bothRouter,
    fragments: bothFragmentsProvider,
    port: 0,
    hostname: "127.0.0.1",
    provides: [bothStatusFragment],
  });

/** One procedure that streams and one that does not, so a method rule can be told apart from a path rule. */
const streamContract = oc.router({
  ticks: oc.output(eventIterator(z.object({ n: z.number() }))),
  hello: oc,
});

const streamRouterOf = (released: { value: boolean }) =>
  publicApi.OrpcRouter(streamContract)({
    inject: {},
    sync: () => ({
      ticks: ({ signal }) => {
        async function* ticks() {
          let n = 0;
          try {
            while (!signal?.aborted) {
              yield { n };
              n += 1;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          } finally {
            released.value = true;
          }
        }
        return OkAsync(ticks());
      },
      hello: () => OkAsync("hello"),
    }),
  });

const streamAppOf = (released: { value: boolean }) =>
  HttpModule("StreamApp")({
    router: streamRouterOf(released),
    port: 0,
    hostname: "127.0.0.1",
    provides: [],
  });

/**
 * The same fragments alone, mounted off a PINNED prefix instead of the
 * default `/` — proves `fragmentsPrefix` actually reaches `htmx()` rather
 * than being silently defaulted: the fragment answers under the pinned mount
 * and nothing answers at `/`, since no router is composed to own it either.
 */
const fragmentsOnlyAppOf = () =>
  HttpModule("FragmentsOnlyApp")({
    fragments: bothFragmentsProvider,
    fragmentsPrefix: "/ui",
    port: 0,
    hostname: "127.0.0.1",
    provides: [bothStatusFragment],
  });

/**
 * A router and fragments marked with the SAME scheme through ONE `defineHttp`
 * registry — the shape `HttpModule`'s reference-dedup exists for: both
 * providers carry the identical `HttpAuthenticator:user` provider object, and
 * both protocols resolve it end to end.
 */
const sharedAuthApi = defineHttp({
  authenticators: {
    user: HttpAuthenticator<{ readonly userId: string }>()({
      inject: {},
      sync: () => (headers) =>
        headers.authorization === "Bearer good"
          ? OkAsync({ userId: "u-1" })
          : ErrAsync(new Unauthenticated()),
    }),
  },
});

const sharedAuthContract = { whoami: authenticated({ user: [] })(oc.output(ocType<string>())) };
const sharedAuthRouter = sharedAuthApi.OrpcRouter(sharedAuthContract)({
  inject: {},
  sync: () => ({ whoami: ({ context }) => OkAsync(context.principal.userId) }),
});

const sharedAuthProfileFragment = sharedAuthApi.HtmxGet("/profile", { requires: [{ user: [] }] })({
  inject: {},
  sync: () => (context) => OkAsync(html`<p>${context.principal.userId}</p>`),
});
const sharedAuthFragmentsProvider = sharedAuthApi.HtmxFragments([sharedAuthProfileFragment]);

const sharedAuthAppOf = () =>
  HttpModule("SharedAuthApp")({
    router: sharedAuthRouter,
    fragments: sharedAuthFragmentsProvider,
    port: 0,
    hostname: "127.0.0.1",
    provides: [sharedAuthProfileFragment],
  });

/**
 * A one-procedure `greet` contract, named for the plugin test's own request
 * path: the CORS plugin only decorates a MATCHED response.
 */
const corsContract = oc.router({
  greet: oc.input(ocType<{ readonly name: string }>()).output(ocType<string>()),
});

const corsRouter = publicApi.OrpcRouter(corsContract)({
  inject: {},
  sync: () => ({ greet: ({ input }) => OkAsync(`hello ${input.name}`) }),
});

/** The two ways a `rpcPolicy` test calls `greet`: through fetch, and raw enough to see the encoding. */
type PolicyCalls = {
  readonly url: string;
  /** `POST /rpc/greet` with `name` as its input, plus whatever headers the test adds. */
  readonly greet: (name: string, headers?: Readonly<Record<string, string>>) => Promise<Response>;
  /**
   * The same call over `node:http` with `accept-encoding` set, answering the
   * response's `content-encoding` — fetch decodes and would hide it.
   */
  readonly encodingOf: (name: string) => Promise<string | undefined>;
};

const callsOf = (url: string): PolicyCalls => ({
  url,
  greet: (name, headers = {}) =>
    fetch(`${url}/rpc/greet`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ json: { name } }),
    }),
  encodingOf: (name) =>
    new Promise((resolve) => {
      const request = httpRequest(
        `${url}/rpc/greet`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "accept-encoding": "gzip, deflate" },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.headers["content-encoding"]));
        },
      );
      // Resolved rather than left hanging: the test's own assertion is what
      // should report the failure, not vitest's timeout.
      request.once("error", (cause) => resolve(String(cause)));
      request.end(JSON.stringify({ json: { name } }));
    }),
});

/** The transport policy a `rpcPolicy` test configures — `http()`'s own fields. */
type PolicyOptions = Pick<HttpOptions, "cors" | "bodyLimit" | "compression" | "plugins">;

/** The same starter shape as `rpcAppOf`, over whatever transport policy a test configures. */
const rpcPolicyAppOf = (options: PolicyOptions) =>
  HttpModule("RpcPolicyApp")({
    router: corsRouter,
    port: 0,
    hostname: "127.0.0.1",
    ...options,
  });

/** Whatever `HttpConfig` the graph bound, captured by a provider that depends on it. */
class BoundConfig extends Port("BoundConfig")<{ readonly value: ServiceOf<HttpConfig> }> {}

/** The starter left to configure itself — from the environment, plus whatever `options` pins. */
const configuredAppOf = (options: { readonly port?: number; readonly hostname?: string }) => {
  let bound: ServiceOf<HttpConfig> | undefined;
  return {
    module: Module("ConfiguredApp")({
      imports: [httpServer({ ...options })],
      provides: [
        answering(noop),
        Provider(BoundConfig)({
          inject: { config: HttpConfig },
          sync: ({ config }) => {
            bound = config;
            return { value: config };
          },
        }),
      ],
      exports: [HttpRuntime, HttpHandler],
    }),
    config: () => bound,
  };
};

type App = RunningApp<ConfigInvalid, HttpInfo>;

/**
 * A graph serving several answerers at once — what a deployment mounting oRPC,
 * GraphQL and fragments side by side looks like, with each answerer naming
 * itself in the body so a test can tell which one took the request.
 */
const mountedAppOf = (prefixes: readonly `/${string}`[]) =>
  Module("MountedApp")({
    imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
    provides: prefixes.map((prefix) =>
      answering(
        (_request, response) => new Promise<void>((done) => response.end(prefix, () => done())),
        prefix,
      ),
    ),
    exports: [HttpRuntime, HttpHandler],
  });

const noop: Handler = (_request, response, _signal) =>
  new Promise<void>((done) => response.end("ok", () => done()));

/**
 * Two schemes, dedicated to the fixtures below and kept SEPARATE from `api`'s
 * own registry: `orderRowFragment` and `healthFragment` require "user",
 * `adminOnlyFragment` requires "service" — two DIFFERENT scheme names — so a
 * test can tell one route's own requirement from another's by which scheme
 * key resolved, not merely by requirement identity.
 */
const htmxUserAuthenticator = HttpAuthenticator<{ readonly userId: string }>()({
  inject: {},
  sync: () => () => OkAsync({ userId: "u-1" }),
});
const htmxServiceAuthenticator = HttpAuthenticator<{ readonly appId: string }>()({
  inject: {},
  sync: () => () => OkAsync({ appId: "a-1" }),
});
const htmxApi = defineHttp({
  authenticators: { user: htmxUserAuthenticator, service: htmxServiceAuthenticator },
});

const orderRowFragment = htmxApi.HtmxGet("/orders/:id/row", { requires: [{ user: [] }] })({
  inject: { greeter: Greeter },
  sync:
    ({ greeter }) =>
    (context, params) =>
      OkAsync(html`<tr>${greeter.greet(context.principal.userId)}:${params.id}</tr>`),
});

const healthFragment = htmxApi.HtmxGet("/health", { requires: [{ user: [] }] })({
  inject: {},
  sync: () => () => OkAsync(html`<p>ok</p>`),
});

const adminOnlyFragment = htmxApi.HtmxGet("/admin", { requires: [{ service: [] }] })({
  inject: {},
  sync: () => () => OkAsync(html`<p>admin</p>`),
});

const htmxFragmentsProvider = htmxApi.HtmxFragments([
  orderRowFragment,
  healthFragment,
  adminOnlyFragment,
]);

/** The composed port, built the way the kernel does — through a scoped graph — and read back. */
const htmxServiceOf = (): AsyncResult<ServiceOf<typeof HtmxFragmentsPort>, never> =>
  Module.scoped(
    Module("HtmxFixture")({
      provides: [
        Provider(Greeter)({ inject: {}, value: { greet: (name: string) => `hi ${name}` } }),
        orderRowFragment,
        healthFragment,
        adminOnlyFragment,
        htmxFragmentsProvider,
        ...htmxFragmentsProvider.authenticators,
      ],
      exports: [HtmxFragmentsPort],
    }),
    (ctx) => OkAsync(ctx.get(HtmxFragmentsPort)),
  );

/**
 * `htmx()` over a real listener: an unmarked GET with a path parameter, a POST
 * on the SAME path carrying an input schema (the method-is-part-of-the-match
 * pair the brief for `htmx()` names), a route requiring the scheme with no
 * scope, one requiring a scope its authenticator never grants, a POST
 * declaring no schema at all — the "hand the decoded record through" arm —
 * and a MARKED POST (`secure`), the one shape none of the others cover: a
 * route that both authenticates (so `respond` awaits first) and reads a body
 * (so it reaches `readBody` only after that await yields) — the exact window
 * a client can abort inside.
 */
const noteInput = z.object({ note: z.string() });

const htmxRuntimeAuthenticator = HttpAuthenticator<{ readonly userId: string }, "admin">()({
  inject: {},
  sync: () => (headers) => {
    if (headers.authorization === "Bearer boom") {
      return OkAsync().map((): Grant<{ readonly userId: string }, "admin"> => {
        // oxlint-disable-next-line unthrown/no-throw -- an authenticator bug IS the subject under test, and a throw inside a combinator is the only way to mint a Defect
        throw new Error("authenticator bug");
      });
    }
    return headers.authorization === "Bearer good"
      ? OkAsync(granted<{ readonly userId: string }, "admin">({ userId: "u-1" }, []))
      : ErrAsync(new Unauthenticated());
  },
});

const htmxRuntimeApi = defineHttp({ authenticators: { user: htmxRuntimeAuthenticator } });

let htmxRowGetRuns = 0;
let htmxRowUpdateRuns = 0;

/** The deps arm's own dependency — a route calling a use case, as a real slice does. */
class RowGetCounter extends Port("RowGetCounter")<{ readonly increment: () => void }> {}

const htmxRowFragment = htmxRuntimeApi.HtmxGet("/orders/:id/row")({
  inject: { counter: RowGetCounter },
  sync:
    ({ counter }) =>
    (_context, params) => {
      counter.increment();
      return OkAsync(html`<tr id="row-${params.id}">row</tr>`);
    },
});

const htmxRowUpdateFragment = htmxRuntimeApi.HtmxPost("/orders/:id/row", { input: noteInput })({
  inject: {},
  sync: () => (_context, params, input) => {
    htmxRowUpdateRuns += 1;
    return OkAsync(html`<tr id="row-${params.id}">${input.note}</tr>`);
  },
});

const htmxProfileFragment = htmxRuntimeApi.HtmxGet("/profile", { requires: [{ user: [] }] })({
  inject: {},
  sync: () => (context) => OkAsync(html`<p>hi ${context.principal.userId}</p>`),
});

const htmxAdminPanelFragment = htmxRuntimeApi.HtmxGet("/admin", {
  requires: [{ user: ["admin"] }],
})({ inject: {}, sync: () => () => OkAsync(html`<p>admin</p>`) });

const htmxEchoFragment = htmxRuntimeApi.HtmxPost("/echo")({
  inject: {},
  sync: () => (_context, _params, input) => OkAsync(html`<p>${JSON.stringify(input)}</p>`),
});

const htmxSecureFragment = htmxRuntimeApi.HtmxPost("/secure", { requires: [{ user: [] }] })({
  inject: {},
  sync: () => (context) => OkAsync(html`<p>secure ${context.principal.userId}</p>`),
});

const htmxRuntimeFragmentsProvider = htmxRuntimeApi.HtmxFragments([
  htmxRowFragment,
  htmxRowUpdateFragment,
  htmxProfileFragment,
  htmxAdminPanelFragment,
  htmxEchoFragment,
  htmxSecureFragment,
]);

/**
 * One public route and one requiring `user`, both under `htmxRuntimeApi` — the
 * pair the unit-kind tests need: an unmarked leaf opens `anonymous`, a marked
 * one opens the scheme that resolved.
 */
const htmxKindedPublicFragment = htmxRuntimeApi.HtmxGet("/kinded/public")({
  inject: {},
  sync: () => () => OkAsync(html`<p>public</p>`),
});

const htmxKindedPrivateFragment = htmxRuntimeApi.HtmxGet("/kinded/private", {
  requires: [{ user: [] }],
})({ inject: {}, sync: () => () => OkAsync(html`<p>private</p>`) });

/** The same registry, retyped by the kinds it binds — what types `context.unit`. */
const kindedHtmxApi = htmxRuntimeApi.units<{
  anonymous: KindedUnits["anonymous"];
  user: KindedUnits["user"];
}>();

/** A third route, reading a port only the `user` kind's module exports back off its fork. */
const htmxKindedWhoamiFragment = kindedHtmxApi.HtmxGet("/kinded/whoami", {
  requires: [{ user: [] }],
})({
  inject: {},
  unit: { userId: KindedUserId },
  sync: () => (context) => OkAsync(html`<p>${context.unit.userId}</p>`),
});

const htmxKindedFragmentsProvider = htmxRuntimeApi.HtmxFragments([
  htmxKindedPublicFragment,
  htmxKindedPrivateFragment,
  htmxKindedWhoamiFragment,
]);

const htmxRuntimeAppOf = (bodyLimit?: number) =>
  Module("HtmxRuntimeApp")({
    imports: [
      httpServer({
        port: 0,
        hostname: "127.0.0.1",
        ...(bodyLimit === undefined ? {} : { bodyLimit }),
      }),
    ],
    provides: [
      htmx(),
      Provider(RowGetCounter)({ inject: {}, value: { increment: () => (htmxRowGetRuns += 1) } }),
      htmxRowFragment,
      htmxRowUpdateFragment,
      htmxProfileFragment,
      htmxAdminPanelFragment,
      htmxEchoFragment,
      htmxSecureFragment,
      htmxRuntimeFragmentsProvider,
      ...htmxRuntimeFragmentsProvider.authenticators,
    ],
    exports: [HttpRuntime, HttpHandler],
  });

/**
 * The `htmx()` answerer itself, built the way the kernel does, over a
 * hand-provided `HttpConfig` rather than `httpServer()` — so a defect from a
 * request stream can be driven straight through `handle` with a synthetic
 * request, no socket involved. A real socket's premature close is racy
 * against Node's own default `clientError` response (measured), which is
 * what this seam avoids.
 */
const htmxAnswererOf = (): AsyncResult<HttpAnswerer, never> =>
  Module.scoped(
    Module("HtmxAnswererFixture")({
      provides: [
        Provider(HttpConfig)({
          inject: {},
          value: {
            port: 0,
            hostname: "127.0.0.1",
            bodyLimit: 0,
            corsOrigin: "",
            compression: false,
          },
        }),
        Provider(HttpUnit)({ inject: {}, value: {} }),
        htmx(),
        Provider(RowGetCounter)({ inject: {}, value: { increment: () => (htmxRowGetRuns += 1) } }),
        htmxRowFragment,
        htmxRowUpdateFragment,
        htmxProfileFragment,
        htmxAdminPanelFragment,
        htmxEchoFragment,
        htmxSecureFragment,
        htmxRuntimeFragmentsProvider,
        ...htmxRuntimeFragmentsProvider.authenticators,
      ],
      exports: [HttpHandler],
    }),
    (ctx) => {
      const answerer = ctx.get(HttpHandler).at(0);
      assert.ok(answerer !== undefined, "htmx() contributed no HttpHandler member");
      return OkAsync(answerer);
    },
  );

export type HttpFixtures = {
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /**
   * Starts an app on an ephemeral port through `boot`, so its shutdown is the
   * fixture's — on every exit path, a failing assertion included.
   */
  readonly serve: (
    handler?: Handler,
    securityHeaders?: HttpOptions["securityHeaders"],
  ) => Promise<{ readonly app: App; readonly origin: string }>;
  /**
   * An app whose starter binds `HttpConfig` from `env` (plus whatever `options`
   * pins), and what it bound. Shut down by the fixture; a startup failure is
   * the test's to assert on `app.exited`.
   */
  readonly configured: (
    env: Environment,
    options?: { readonly port?: number; readonly hostname?: string },
  ) => {
    readonly app: RunningApp<ConfigInvalid, HttpInfo>;
    readonly config: () => ServiceOf<HttpConfig> | undefined;
  };
  /**
   * The starter proper — `HttpModule` over a router provider — on an
   * ephemeral port, with a typed oRPC client pointed at it. Shut down by the
   * fixture.
   */
  readonly rpc: (
    prefix?: `/${string}`,
    /** Serve `strayRouter` — the implementation with a key the contract never declared — instead. */
    stray?: boolean,
  ) => Promise<{
    readonly origin: string;
    readonly client: RouterContractClient<typeof greetingContract>;
  }>;
  /** An app bound to an `anonymous` unit module that counts its builds and teardowns. */
  readonly scoped: {
    readonly serve: () => Promise<{
      readonly app: App;
      readonly origin: string;
      readonly counts: () => { builds: number; stops: number };
    }>;
  };
  /** Like `scoped`, but for a fragment route — proves htmx forks the same way oRPC does. */
  readonly scopedFragment: {
    readonly serve: () => Promise<{
      readonly app: App;
      readonly origin: string;
      readonly counts: () => { builds: number; stops: number };
    }>;
  };
  /**
   * The starter over a router with one MARKED and one unmarked leaf, bound to
   * whichever kinds `serve` names — the unit-kind selection, end to end. Shut
   * down by the fixture.
   */
  readonly kindedRpc: {
    readonly serve: (kinds: readonly ("anonymous" | "user")[]) => Promise<{
      readonly clientWith: (token: string | undefined) => AuthedClient;
      readonly counts: () => KindCounts;
      readonly seen: () => readonly unknown[];
    }>;
  };
  /**
   * The same app whose marked leaf reads the forked module's export back off
   * `context.unit`, with both kinds bound.
   */
  readonly unitRecordRpc: () => Promise<{
    readonly clientWith: (token: string | undefined) => AuthedClient;
  }>;
  /** The same over htmx fragments — one public route, one requiring `user`. */
  readonly kindedHtmx: {
    readonly serve: (kinds: readonly ("anonymous" | "user")[]) => Promise<{
      readonly origin: string;
      readonly counts: () => KindCounts;
      readonly seen: () => readonly unknown[];
    }>;
  };
  /**
   * An app, serving both protocols, whose bound `anonymous` unit module fails
   * to build — the fork's own defect path, for each answerer to answer 500.
   */
  readonly brokenScoped: () => Promise<{ readonly app: App; readonly origin: string }>;
  /** An app started on an explicit port, for the failure paths. Shut down by the fixture. */
  readonly appOnPort: (port: number) => App;
  /** The same, over a hand-provided `HttpConfig` — no `Config` rule in the way. */
  readonly appOnUncheckedPort: (port: number) => App;
  readonly occupied: { readonly appOnTakenPort: App };
  /** The `http.Server` the runtime just created. Asserted here so a test body cannot pass on an empty capture. */
  readonly boundServer: () => Server;
  /** A handler held open until `release()`, so a test can observe a unit in flight. */
  readonly gate: {
    readonly handler: Handler;
    readonly arrived: Promise<void>;
    readonly release: () => void;
  };
  /**
   * Like `gate`, except the handler flushes its headers before holding — the
   * state `retire`'s `headersSent` branch exists for. This package's own router
   * never produces it, but a handler is free to.
   */
  readonly streamedGate: {
    readonly handler: Handler;
    readonly arrived: Promise<void>;
    readonly release: () => void;
  };
  /** A handler that records the ambient record the kernel opened for its unit. */
  readonly traced: {
    readonly handler: Handler;
    readonly seen: () => readonly (string | undefined)[];
  };
  /**
   * A raw keep-alive connection held BUSY across a drain, which `fetch` cannot
   * express: undici owns its pool and `Connection` is hop-by-hop. Busy is the
   * point — `closeIdleConnections()` reaches every IDLE connection and no others.
   */
  readonly keepAlive: {
    readonly call: (origin: string) => Promise<{
      readonly head: () => Promise<string>;
      /** Resolves once the raw socket itself closes — the observable a header can no longer carry once it is already on the wire. */
      readonly closed: () => Promise<void>;
    }>;
    readonly stoppedAccepting: (origin: string) => Promise<void>;
  };
  /**
   * A stream procedure under the real starter, and a raw subscriber that
   * reports how the body ended — the observable that tells a reset from a
   * clean end, which an oRPC client reads as "finished".
   */
  readonly streaming: {
    readonly serve: () => Promise<{
      readonly app: App;
      readonly origin: string;
      readonly released: () => boolean;
    }>;
    readonly subscribe: (origin: string) => Promise<{
      readonly frames: () => number;
      readonly ended: Promise<"done" | "reset">;
    }>;
  };
  /** The pieces the composing router form takes, and what the unmarked router they build declares. */
  readonly controllers: {
    readonly controller: typeof helloController;
    readonly unmarkedRouterDeps: readonly string[];
  };
  /** A router declaring `inject: {}`, and what its `sync` was handed. */
  readonly noDepsRouter: {
    readonly provider: ReturnType<typeof noDepsRouterRecording>["provider"];
    readonly handed: () => readonly unknown[];
  };
  /**
   * The starter over a router composed from an array of pieces — the same
   * shape as `rpc`, but built from `slicedRouter`. Shut down by the fixture.
   */
  readonly rpcSliced: () => Promise<{
    readonly origin: string;
    readonly client: RouterContractClient<typeof slicedContract>;
  }>;
  /**
   * The starter over `deepContract` — two pieces sharing the nested "v1"
   * parent, plus one minted at the bare procedure path "health". Shut down by
   * the fixture.
   */
  readonly rpcDeep: () => Promise<{
    readonly origin: string;
    readonly client: DeepClient;
  }>;
  /**
   * The starter over a contract whose `orders` fragment is `authenticated(...)`
   * — router, controllers and authenticator all from one `defineHttp(...)`. Shut
   * down by the fixture; the run count is reset before the test body.
   */
  readonly rpcAuthed: {
    /** A typed client presenting `Bearer ${token}`, or no credentials at all when `token` is `undefined`. */
    readonly clientWith: (token: string | undefined) => AuthedClient;
    /** How many times the protected handler has been entered. */
    readonly handlerRuns: () => number;
    readonly url: string;
  };
  /**
   * The starter over a contract whose **root** is `authenticated(...)` — the
   * case no `contract[key]` lookup can see. Shut down by the fixture.
   */
  readonly rpcRootMarked: {
    readonly clientWith: (token: string | undefined) => RootMarkedClient;
    readonly handlerRuns: () => number;
  };
  /**
   * The starter over a contract marked at its **root** and served through a
   * piece minted TWO LEVELS below it (`"v1.orders"`) — the fold-vs-walk proof.
   * Shut down by the fixture.
   */
  readonly rpcRootMarkedDeep: {
    readonly clientWith: (token: string | undefined) => RootMarkedDeepClient;
    readonly handlerRuns: () => number;
  };
  /** What each `OrpcRouter` arm declares as its dependencies over the same marked contract. */
  readonly authedRouterDeps: {
    readonly composed: readonly string[];
    readonly fromDeps: readonly string[];
  };
  /** The starter over a router whose authenticator DECLARES a dependency. Shut down by the fixture. */
  readonly rpcVerified: (token: string) => RootMarkedClient;
  /** The same router with the `user` scheme's authenticator substituted on its port. Shut down by the fixture. */
  readonly rpcSubstituted: (token: string) => RootMarkedClient;
  /**
   * The starter over a one-procedure `greet` router with whatever transport
   * policy the test configures. Shut down by the fixture.
   */
  readonly rpcPolicy: (options: PolicyOptions, env?: Environment) => Promise<PolicyCalls>;
  /**
   * An app serving one answerer per prefix, each answering with its own mount
   * point, plus the origin to call it on. Shut down by the fixture.
   */
  readonly mounted: (prefixes: readonly `/${string}`[]) => Promise<{
    readonly origin: string;
    readonly at: (path: string) => Promise<{ readonly status: number; readonly body: string }>;
  }>;
  /** The same, started but not awaited — for a graph whose mounts collide. */
  readonly mountedApp: (prefixes: readonly `/${string}`[]) => App;
  /** A bare request's headers — the one argument an authenticator is handed. */
  readonly headers: IncomingHttpHeaders;
  /**
   * A graph of `httpServer()` plus one bare answerer at `prefix` answering
   * `body` — the composition `http()` cannot express. Shut down by the fixture.
   */
  readonly serveAnswerer: (
    prefix: `/${string}`,
    body: string,
  ) => Promise<{ readonly origin: string }>;
  /** The htmx fragment pieces and the port they compose into. */
  readonly htmx: {
    readonly orderRowFragment: typeof orderRowFragment;
    readonly service: () => AsyncResult<ServiceOf<typeof HtmxFragmentsPort>, never>;
  };
  /**
   * `htmx()` over a real listener — see `htmxRuntimeAppOf` for the routes it
   * serves. Shut down by the fixture; both run counts are reset before the
   * test body.
   */
  readonly htmxServer: (bodyLimit?: number) => Promise<{
    readonly origin: string;
    readonly rowGetRuns: () => number;
    readonly rowUpdateRuns: () => number;
  }>;
  /** The built `htmx()` answerer itself — see `htmxAnswererOf` for why. */
  readonly htmxAnswerer: () => AsyncResult<HttpAnswerer, never>;
  /**
   * The starter over `HttpModule({ router, fragments })` — both protocols from
   * one runtime on one port. Shut down by the fixture.
   */
  readonly bothProtocols: () => Promise<{
    readonly rpc: () => Promise<string>;
    readonly fragment: () => Promise<string>;
  }>;
  /**
   * The starter over `HttpModule({ fragments, fragmentsPrefix: "/ui" })` —
   * fragments alone, mounted off the pinned prefix. Shut down by the fixture.
   */
  readonly fragmentsOnly: () => Promise<{
    readonly at: (path: string) => Promise<{ readonly status: number; readonly body: string }>;
  }>;
  /**
   * `HttpModule({ router, fragments })` where both share ONE authenticator
   * through one `defineHttp` registry. Shut down by the fixture.
   */
  readonly sharedAuth: () => Promise<{
    readonly rpc: (token: string | undefined) => Promise<string>;
    readonly fragment: (token: string | undefined) => Promise<{
      readonly status: number;
      readonly body: string;
    }>;
  }>;
  /** The transport served over an observer that records what it was handed. */
  readonly observed: (handler: Handler) => Promise<{
    readonly origin: string;
    readonly taken: () => readonly Observation[];
  }>;

  /** A local JWT issuer: a served JWKS, and signers for every token a spec needs. */
  readonly issuer: Awaited<ReturnType<typeof issuerOf>>;
  /** The API-key scheme with two issued keys, resolved. */
  readonly apiKeyService: AuthenticatorService<ServiceIdentity, "reports:read">;
  /** The API-key scheme with no scope vocabulary, resolved. */
  readonly bareApiKeyService: AuthenticatorService<ServiceIdentity>;
  /** The JWT scheme with no scope vocabulary, over this file's own issuer. */
  readonly jwtService: AuthenticatorService<JwtIdentity>;
  /** The JWT scheme declaring `orders:export`, where `scopes` is required. */
  readonly scopedJwtService: AuthenticatorService<JwtIdentity, "orders:export">;
};

export const it = test.extend<HttpFixtures>({
  boot: bootFixture(),

  observed: async ({ boot }, use) => {
    await use(async (handler) => {
      const observer = recordingObserver();
      const app = boot(observedAppOf(handler, observer.member));
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return { origin: `http://127.0.0.1:${info.port}`, taken: observer.taken };
    });
  },

  issuer: [
    // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
    async ({}, use) => {
      const local = await issuerOf();
      await use(local);
      await local.close();
    },
    // Per FILE, not per test: generating the key pairs is the cost, and nothing
    // mutates the issuer, so a file's tests share one.
    { scope: "file" },
  ],

  // oxlint-disable-next-line no-empty-pattern -- see above
  apiKeyService: async ({}, use) => {
    await use(serviceOf(apiKeys));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  bareApiKeyService: async ({}, use) => {
    await use(serviceOf(bareApiKey));
  },

  jwtService: async ({ issuer }, use) => {
    await use(
      serviceOf(
        jwtAuthenticator<JwtIdentity>()({
          jwks: issuer.jwks,
          issuer: "https://issuer.test",
          audience: "orders-api",
          principal: jwtPrincipal,
        }),
      ),
    );
  },

  scopedJwtService: async ({ issuer }, use) => {
    await use(
      serviceOf(
        jwtAuthenticator<JwtIdentity>()({
          jwks: issuer.jwks,
          issuer: "https://issuer.test",
          audience: "orders-api",
          scopes: ["orders:export"],
          principal: jwtPrincipal,
        }),
      ),
    );
  },

  serve: async ({ boot }, use) => {
    await use(async (handler = noop, securityHeaders) => {
      const app = boot(appOf(handler, undefined, securityHeaders));
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return { app, origin: `http://127.0.0.1:${info.port}` };
    });
  },

  configured: async ({ boot }, use) => {
    await use((env, options = {}) => {
      const { module, config } = configuredAppOf(options);
      return { app: boot(module, { env }), config };
    });
  },

  rpc: async ({ boot }, use) => {
    await use(async (prefix, stray) => {
      const app = boot(rpcAppOf(prefix, stray));
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      const client: RouterContractClient<typeof greetingContract> = createORPCClient(
        new RPCLink({ origin, url: prefix ?? "/rpc" }),
      );
      return { origin, client };
    });
  },

  scoped: async ({ boot }, use) => {
    await use({
      serve: async () => {
        const counts = { builds: 0, stops: 0 };
        class Span extends Port("ScopedSpan")<{ readonly at: number }> {}
        const Unit = Module("ScopedUnit")({
          provides: [
            Provider(Span)({
              inject: {},
              sync: () => {
                counts.builds += 1;
                return { at: counts.builds };
              },
              onStop: () => {
                counts.stops += 1;
              },
            }),
          ],
          exports: [Span],
        });
        const app = boot(
          HttpModule("ScopedApp")({
            router: greetingRouter,
            port: 0,
            hostname: "127.0.0.1",
            unit: { anonymous: Unit },
            provides: [
              Provider(Greeter)({ inject: {}, value: { greet: (name) => `hello ${name}` } }),
            ],
          }),
        );
        const info = (await app.runtimeInfo()).get();
        assert.ok(info !== undefined, "the runtime published no Serving.info");
        return { app, origin: `http://127.0.0.1:${info.port}`, counts: () => counts };
      },
    });
  },

  scopedFragment: async ({ boot }, use) => {
    await use({
      serve: async () => {
        const counts = { builds: 0, stops: 0 };
        class Span extends Port("ScopedFragmentSpan")<{ readonly at: number }> {}
        const Unit = Module("ScopedFragmentUnit")({
          provides: [
            Provider(Span)({
              inject: {},
              sync: () => {
                counts.builds += 1;
                return { at: counts.builds };
              },
              onStop: () => {
                counts.stops += 1;
              },
            }),
          ],
          exports: [Span],
        });
        const app = boot(
          HttpModule("ScopedFragmentApp")({
            fragments: scopedFragmentsProvider,
            port: 0,
            hostname: "127.0.0.1",
            unit: { anonymous: Unit },
            provides: [scopedFragment],
          }),
        );
        const info = (await app.runtimeInfo()).get();
        assert.ok(info !== undefined, "the runtime published no Serving.info");
        return { app, origin: `http://127.0.0.1:${info.port}`, counts: () => counts };
      },
    });
  },

  kindedRpc: async ({ boot }, use) => {
    await use({
      serve: async (kinds) => {
        const units = kindedUnitsOf(api.principals.user);
        const app = boot(
          HttpModule("KindedRpcApp")({
            router: authedRouter,
            port: 0,
            hostname: "127.0.0.1",
            unit: Object.fromEntries(kinds.map((kind) => [kind, units[kind]])),
            provides: [authedOrdersController, authedHealthController],
          }),
        );
        const info = (await app.runtimeInfo()).get();
        assert.ok(info !== undefined, "the runtime published no Serving.info");
        const origin = `http://127.0.0.1:${info.port}`;
        return {
          clientWith: (token) => createORPCClient(linkOf(origin, token)),
          counts: units.counts,
          seen: units.seen,
        };
      },
    });
  },

  unitRecordRpc: async ({ boot }, use) => {
    await use(async () => {
      const units = kindedUnitsOf(api.principals.user);
      const app = boot(
        HttpModule("UnitRecordRpcApp")({
          router: unitRouter,
          port: 0,
          hostname: "127.0.0.1",
          unit: { anonymous: units.anonymous, user: units.user },
          provides: [unitOrdersController, unitHealthController],
        }),
      );
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      return { clientWith: (token) => createORPCClient(linkOf(origin, token)) };
    });
  },

  kindedHtmx: async ({ boot }, use) => {
    await use({
      serve: async (kinds) => {
        const units = kindedUnitsOf(htmxRuntimeApi.principals.user);
        const app = boot(
          HttpModule("KindedHtmxApp")({
            fragments: htmxKindedFragmentsProvider,
            port: 0,
            hostname: "127.0.0.1",
            unit: Object.fromEntries(kinds.map((kind) => [kind, units[kind]])),
            provides: [
              htmxKindedPublicFragment,
              htmxKindedPrivateFragment,
              htmxKindedWhoamiFragment,
            ],
          }),
        );
        const info = (await app.runtimeInfo()).get();
        assert.ok(info !== undefined, "the runtime published no Serving.info");
        return {
          origin: `http://127.0.0.1:${info.port}`,
          counts: units.counts,
          seen: units.seen,
        };
      },
    });
  },

  brokenScoped: async ({ boot }, use) => {
    await use(async () => {
      class BrokenSpan extends Port("BrokenScopedSpan")<{ readonly at: number }> {}
      const Broken = Module("BrokenScopedUnit")({
        provides: [
          Provider(BrokenSpan)({
            inject: {},
            sync: () => {
              // oxlint-disable-next-line unthrown/no-throw -- the subject under test: a fork's construction failure must reach the answerer's own defect path
              throw new Error("construction-boom");
            },
          }),
        ],
        exports: [BrokenSpan],
      });
      const app = boot(
        HttpModule("BrokenScopedApp")({
          router: greetingRouter,
          fragments: scopedFragmentsProvider,
          port: 0,
          hostname: "127.0.0.1",
          unit: { anonymous: Broken },
          provides: [
            scopedFragment,
            Provider(Greeter)({ inject: {}, value: { greet: (name) => `hello ${name}` } }),
          ],
        }),
      );
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return { app, origin: `http://127.0.0.1:${info.port}` };
    });
  },

  appOnPort: async ({ boot }, use) => {
    await use((port) => boot(appOf(noop, port)));
  },

  appOnUncheckedPort: async ({ boot }, use) => {
    await use((port) => boot(appOnUncheckedPort(port)));
  },

  occupied: async ({ appOnPort }, use) => {
    const blocker = createServer();
    blocker.on("error", () => {});
    const port = await new Promise<number>((done) => {
      blocker.listen(0, "127.0.0.1", () => {
        const address = blocker.address();
        done(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    await use({ appOnTakenPort: appOnPort(port) });

    blocker.close();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  boundServer: async ({}, use) => {
    await use(() => {
      const server = capturedServers.at(-1);
      assert.ok(server !== undefined, "the node:http mock did not intercept createServer");
      return server;
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });

    await use({
      handler: (_request, response, _signal) => {
        entered();
        return held.then(() => new Promise<void>((done) => response.end("late", () => done())));
      },
      arrived,
      release: () => open(),
    });

    open();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  streamedGate: async ({}, use) => {
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });

    await use({
      handler: (_request, response, _signal) => {
        response.writeHead(200);
        entered();
        return held.then(() => new Promise<void>((done) => response.end("late", () => done())));
      },
      arrived,
      release: () => open(),
    });

    open();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  traced: async ({}, use) => {
    const seen: (string | undefined)[] = [];
    await use({
      handler: (_request, response, _signal) => {
        seen.push(currentUnit()?.traceId);
        return new Promise<void>((done) => response.end("ok", () => done()));
      },
      seen: () => seen,
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  keepAlive: async ({}, use) => {
    const opened: Socket[] = [];
    const portOf = (origin: string): number => Number(new URL(origin).port);

    await use({
      call: async (origin) => {
        const socket = connect(portOf(origin), "127.0.0.1");
        // A raw socket with no `'error'` listener throws on reset, and the drain
        // under test resets it by design.
        socket.on("error", () => {});
        opened.push(socket);
        await once(socket, "connect");

        let received = "";
        const head = new Promise<string>((resolve) => {
          socket.on("data", (chunk: Buffer) => {
            received += chunk.toString("utf8");
            const end = received.indexOf("\r\n\r\n");
            if (end !== -1) resolve(received.slice(0, end));
          });
        });
        const closed = once(socket, "close").then(() => undefined);

        socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
        return { head: () => head, closed: () => closed };
      },
      // A fresh connection being refused is the only honest observable: the phase
      // moves to `"draining"` a tick before `stopAccepting` runs.
      stoppedAccepting: async (origin) => {
        const port = portOf(origin);
        await vi.waitUntil(async () => {
          const probe = connect(port, "127.0.0.1");
          const refused = await new Promise<boolean>((resolve) => {
            probe.once("connect", () => resolve(false));
            probe.once("error", () => resolve(true));
          });
          probe.destroy();
          return refused;
        });
      },
    });

    for (const socket of opened) socket.destroy();
  },

  streaming: async ({ boot }, use) => {
    await use({
      serve: async () => {
        const released = { value: false };
        const app = boot(streamAppOf(released), { drainTimeoutMs: 200 });
        const info = (await app.runtimeInfo()).get();
        assert.ok(info !== undefined, "the runtime published no Serving.info");
        return {
          app,
          origin: `http://127.0.0.1:${info.port}`,
          released: () => released.value,
        };
      },
      subscribe: async (origin) => {
        const response = await fetch(`${origin}/rpc/ticks`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: "{}",
        });
        assert.ok(response.body !== null, "the stream has no body");
        const reader = response.body.getReader();
        let frames = 0;
        const ended = (async (): Promise<"done" | "reset"> => {
          try {
            for (;;) {
              const { done } = await reader.read();
              if (done) return "done";
              frames += 1;
            }
          } catch {
            return "reset";
          }
        })();
        return { frames: () => frames, ended };
      },
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  controllers: async ({}, use) => {
    await use({
      controller: helloController,
      unmarkedRouterDeps: slicedRouter.deps.map((dep) => dep.portId),
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  noDepsRouter: async ({}, use) => {
    await use(noDepsRouterRecording());
  },

  rpcSliced: async ({ boot }, use) => {
    await use(async () => {
      const app = boot(rpcSlicedAppOf());
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      const client: RouterContractClient<typeof slicedContract> = createORPCClient(
        new RPCLink({ origin, url: "/rpc" }),
      );
      return { origin, client };
    });
  },

  rpcDeep: async ({ boot }, use) => {
    await use(async () => {
      const app = boot(rpcDeepAppOf());
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      const client: DeepClient = createORPCClient(new RPCLink({ origin, url: "/rpc" }));
      return { origin, client };
    });
  },

  rpcAuthed: async ({ boot }, use) => {
    const app = boot(rpcAuthedAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    authedRuns = 0;

    await use({
      clientWith: (token) => createORPCClient(linkOf(origin, token)),
      handlerRuns: () => authedRuns,
      url: `${origin}/rpc`,
    });
  },

  rpcRootMarked: async ({ boot }, use) => {
    const app = boot(rpcRootMarkedAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    rootMarkedRuns = 0;

    await use({
      clientWith: (token) => createORPCClient(linkOf(origin, token)),
      handlerRuns: () => rootMarkedRuns,
    });
  },

  rpcRootMarkedDeep: async ({ boot }, use) => {
    const app = boot(rpcRootMarkedDeepAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    rootMarkedDeepRuns = 0;

    await use({
      clientWith: (token) => createORPCClient(linkOf(origin, token)),
      handlerRuns: () => rootMarkedDeepRuns,
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  authedRouterDeps: async ({}, use) => {
    await use({
      composed: authedRouter.deps.map((dep) => dep.portId),
      fromDeps: authedWholeRouter.deps.map((dep) => dep.portId),
    });
  },

  rpcVerified: async ({ boot }, use) => {
    const app = boot(rpcVerifiedAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    await use((token) => createORPCClient(linkOf(origin, token)));
  },

  rpcSubstituted: async ({ boot }, use) => {
    const app = boot(rpcSubstitutedAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    await use((token) => createORPCClient(linkOf(origin, token)));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  headers: async ({}, use) => {
    await use({});
  },

  mountedApp: async ({ boot }, use) => {
    await use((prefixes) => boot(mountedAppOf(prefixes)));
  },

  mounted: async ({ boot }, use) => {
    await use(async (prefixes) => {
      const app = boot(mountedAppOf(prefixes));
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      return {
        origin,
        at: async (path) => {
          const response = await fetch(`${origin}${path}`);
          return { status: response.status, body: await response.text() };
        },
      };
    });
  },

  rpcPolicy: async ({ boot }, use) => {
    await use(async (options, env = {}) => {
      const app = boot(rpcPolicyAppOf(options), { env });
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return callsOf(`http://127.0.0.1:${info.port}`);
    });
  },

  serveAnswerer: async ({ boot }, use) => {
    await use(async (prefix, body) => {
      const app = boot(
        Module("AnswererOnly")({
          imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
          provides: [
            answering(
              (_request, response) => new Promise<void>((done) => response.end(body, () => done())),
              prefix,
            ),
          ],
          exports: [HttpRuntime, HttpHandler],
        }),
      );
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return { origin: `http://127.0.0.1:${info.port}` };
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  htmx: async ({}, use) => {
    await use({ orderRowFragment, service: htmxServiceOf });
  },

  htmxServer: async ({ boot }, use) => {
    await use(async (bodyLimit) => {
      htmxRowGetRuns = 0;
      htmxRowUpdateRuns = 0;
      const app = boot(htmxRuntimeAppOf(bodyLimit));
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return {
        origin: `http://127.0.0.1:${info.port}`,
        rowGetRuns: () => htmxRowGetRuns,
        rowUpdateRuns: () => htmxRowUpdateRuns,
      };
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  htmxAnswerer: async ({}, use) => {
    await use(htmxAnswererOf);
  },

  bothProtocols: async ({ boot }, use) => {
    await use(async () => {
      const app = boot(bothProtocolsAppOf());
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      const client: RouterContractClient<typeof bothContract> = createORPCClient(
        new RPCLink({ origin, url: "/rpc" }),
      );
      return {
        rpc: () => client.ping(),
        fragment: async () => (await fetch(`${origin}/status`)).text(),
      };
    });
  },

  fragmentsOnly: async ({ boot }, use) => {
    await use(async () => {
      const app = boot(fragmentsOnlyAppOf());
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      return {
        at: async (path) => {
          const response = await fetch(`${origin}${path}`);
          return { status: response.status, body: await response.text() };
        },
      };
    });
  },

  sharedAuth: async ({ boot }, use) => {
    await use(async () => {
      const app = boot(sharedAuthAppOf());
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      const clientWith = (token: string | undefined) =>
        createORPCClient<RouterContractClient<typeof sharedAuthContract>>(linkOf(origin, token));
      return {
        rpc: (token) => clientWith(token).whoami(),
        fragment: async (token) => {
          const response = await fetch(
            `${origin}/profile`,
            token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
          );
          return { status: response.status, body: await response.text() };
        },
      };
    });
  },
});
