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
import { connect, type Socket } from "node:net";

import type { ConfigInvalid, Environment } from "@btravstack/config";
import { authenticated } from "@btravstack/contract";
import { currentUnit, type RunningApp } from "@btravstack/core";
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { bootFixture, type Boot } from "@btravstack/testing";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type as ocType, type RouterContractClient } from "@orpc/contract";
import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";
import { test } from "vitest";
import { z } from "zod";

import {
  HttpAuthenticator,
  Unauthenticated,
  authenticatorPort,
  granted,
  type Grant,
} from "../auth.js";
import { defineHttp } from "../define-http.js";
import { defineFragments } from "../fragments.js";
import { HttpHandler, type HttpAnswerer } from "../handler.js";
import { html } from "../html.js";
import { HtmxFragmentsPort } from "../htmx-controller.js";
import { htmx } from "../htmx.js";
import { HttpConfig } from "../http-config.js";
import { HttpModule } from "../http-module.js";
import { HttpRuntime, http, httpServer, type HttpInfo, type HttpOptions } from "../http-runtime.js";

/** What a bare answerer's `handle` is, without the mount point around it. */
type Handler = HttpAnswerer["handle"];

/** That handler as the one answerer of a graph, mounted at the root. */
const answering = (handle: Handler, prefix: `/${string}` = "/") =>
  Provider.member(HttpHandler)({ value: { prefix, handle } });

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
const greetingRouter = publicApi.HttpRouter(greetingContract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => greetingImplementation(greeter),
  },
);

/** The composing form's own contract, so the two arms are exercised side by side. */
const slicedContract = oc.router({ greetings: helloFragment, echoes: nestedFragment });

/**
 * Two pieces over `slicedContract` — the path is the port's name. The second is
 * minted by a DOTTED path, so the composing arm's `nest` rebuild is exercised
 * on a real request rather than only on top-level keys.
 */
export const helloController = publicApi.HttpController(slicedContract, "greetings")(
  { greeter: Greeter },
  { sync: ({ greeter }) => ({ hello: () => OkAsync(greeter.greet("world")) }) },
);

const echoesController = publicApi.HttpController(
  slicedContract,
  "echoes.ping",
)({
  sync: () => () => OkAsync("pong"),
});

/**
 * An arm-only router whose `sync` records its own arity. The arm-only form is
 * typed `() => Implementation`, so the runtime must hand it nothing; passing a
 * record would be invisible to an arrow and visible to a rest parameter.
 */
export const armOnlyRouterRecording = () => {
  let seen = -1;
  const provider = publicApi.HttpRouter(oc.router({ greetings: helloFragment }))({
    sync: (...args: readonly unknown[]) => {
      seen = args.length;
      return { greetings: { hello: () => OkAsync("hello world") } };
    },
  } as never);
  return { provider, arity: () => seen };
};

/** The same kind of API as `greetingRouter`, composed from pieces instead of one `sync`. */
const slicedRouter = publicApi.HttpRouter(slicedContract)([helloController, echoesController]);

/** `HttpModule` over the composed router, mirroring `rpcAppOf`. */
const rpcSlicedAppOf = () =>
  HttpModule("RpcSlicedApp")({
    router: slicedRouter,
    port: 0,
    hostname: "127.0.0.1",
    provides: [
      helloController,
      echoesController,
      Provider(Greeter)({ value: { greet: (name) => `hello ${name}` } }),
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

const v1OrdersController = publicApi.HttpController(
  deepContract,
  "v1.orders",
)({
  sync: () => ({ place: () => OkAsync({ id: "o-1" }) }),
});
const v1CustomersController = publicApi.HttpController(
  deepContract,
  "v1.customers",
)({
  sync: () => ({ find: () => OkAsync({ id: "c-1" }) }),
});
const deepHealthController = publicApi.HttpController(
  deepContract,
  "health",
)({ sync: () => () => OkAsync({ ok: true as const }) });

const deepRouter = publicApi.HttpRouter(deepContract)([
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

const authedOrdersController = api.HttpController(
  authedContract,
  "orders",
)({
  sync: () => ({
    whoami: ({ context }) => {
      authedRuns += 1;
      return OkAsync({ userId: context.principal.userId });
    },
  }),
});

const authedHealthController = api.HttpController(
  authedContract,
  "health",
)({
  sync: () => ({ ping: () => OkAsync({ ok: true as const }) }),
});

const authedRouter = api.HttpRouter(authedContract)([
  authedOrdersController,
  authedHealthController,
]);

/**
 * The same marked contract through the deps form, so the scheme's own key on
 * the deps record is pinned for both arms of `build`.
 */
const authedPositionalRouter = api.HttpRouter(authedContract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      orders: {
        whoami: ({ context }) => OkAsync({ userId: greeter.greet(context.principal.userId) }),
      },
      health: { ping: () => OkAsync({ ok: true as const }) },
    }),
  },
);

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

const rootMarkedRouter = api.HttpRouter(rootMarkedContract)({
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

const rootMarkedDeepController = api.HttpController(
  rootMarkedDeepContract,
  "v1.orders",
)({
  sync: () => ({
    whoami: ({ context }) => {
      rootMarkedDeepRuns += 1;
      return OkAsync({ userId: context.principal.userId });
    },
  }),
});

const rootMarkedDeepRouter = api.HttpRouter(rootMarkedDeepContract)([rootMarkedDeepController]);

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
    user: HttpAuthenticator<Identity>()(
      { tokens: TokenTable },
      {
        sync:
          ({ tokens }) =>
          (headers) => {
            const claimed = tokens(headers.authorization ?? "");
            return claimed === undefined ? ErrAsync(new Unauthenticated()) : OkAsync(claimed);
          },
      },
    ),
  },
});

const verifiedRouter = verifying.HttpRouter({
  orders: authenticated({ user: [] })({ whoami }),
})({
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
        value: () => OkAsync({ userId: "u-stub" }),
      }),
    ],
    exports: [HttpRuntime, HttpHandler],
  });

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
const strayRouter = publicApi.HttpRouter(greetingContract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) =>
      ({ ...greetingImplementation(greeter), stray: () => OkAsync("stray") }) as ReturnType<
        typeof greetingImplementation
      >,
  },
);

/** The starter as an application uses it: `HttpModule` sugar over a router provider. */
const rpcAppOf = (prefix?: `/${string}`, stray = false) =>
  HttpModule("RpcApp")({
    router: stray ? strayRouter : greetingRouter,
    port: 0,
    hostname: "127.0.0.1",
    ...(prefix === undefined ? {} : { prefix }),
    provides: [Provider(Greeter)({ value: { greet: (name) => `hello ${name}` } })],
  });

/**
 * An unrelated router and fragments, composed by ONE `HttpModule` call — a
 * proof that a root can serve both protocols from one runtime on one port.
 * Public and minimal on purpose: the gate under test is the composition, not
 * either protocol's own behaviour, which the rest of this file already
 * covers.
 */
const bothContract = oc.router({ ping: oc.output(ocType<string>()) });
const bothRouter = publicApi.HttpRouter(bothContract)({
  sync: () => ({ ping: () => OkAsync("pong") }),
});

const bothStatusFragment = publicApi.HtmxGet("/status")({
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
      sync: () => (headers) =>
        headers.authorization === "Bearer good"
          ? OkAsync({ userId: "u-1" })
          : ErrAsync(new Unauthenticated()),
    }),
  },
});

const sharedAuthContract = { whoami: authenticated({ user: [] })(oc.output(ocType<string>())) };
const sharedAuthRouter = sharedAuthApi.HttpRouter(sharedAuthContract)({
  sync: () => ({ whoami: ({ context }) => OkAsync(context.principal.userId) }),
});

const sharedAuthProfileFragment = sharedAuthApi.HtmxGet("/profile", { requires: [{ user: [] }] })({
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

const corsRouter = publicApi.HttpRouter(corsContract)({
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
      imports: [httpServer(options)],
      provides: [
        answering(noop),
        Provider(BoundConfig)(
          { config: HttpConfig },
          {
            sync: ({ config }) => {
              bound = config;
              return { value: config };
            },
          },
        ),
      ],
      exports: [HttpRuntime, HttpHandler],
    }),
    config: () => bound,
  };
};

/** A unit-scoped port whose construction is held open, so a unit's work can be delayed past its client's patience. */
class Slow extends Port("Slow")<{ readonly built: true }> {}

type SlowUnit = {
  readonly module: Module<Slow, never, never>;
  /** Resolves once a unit has started building the module. */
  readonly arrived: Promise<void>;
  /** Lets every held construction finish. */
  readonly release: () => void;
};

const slowUnitOf = (): SlowUnit => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    module: Module("SlowUnit")({
      provides: [
        Provider(Slow)({
          make: () => {
            entered();
            return fromSafePromise(held.then(() => ({ built: true }) as const));
          },
        }),
      ],
      exports: [Slow],
    }),
    arrived,
    release: () => release(),
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
 * own registry: `htmxFragments`' contract mark names "user" and its
 * `adminOnly` route overrides with "service" — two DIFFERENT scheme names —
 * so a test can tell "found the contract's mark" from "found the route's
 * mark" by which scheme key resolved, not merely by requirement identity.
 */
const htmxUserAuthenticator = HttpAuthenticator<{ readonly userId: string }>()({
  sync: () => () => OkAsync({ userId: "u-1" }),
});
const htmxServiceAuthenticator = HttpAuthenticator<{ readonly appId: string }>()({
  sync: () => () => OkAsync({ appId: "a-1" }),
});
const htmxApi = defineHttp({
  authenticators: { user: htmxUserAuthenticator, service: htmxServiceAuthenticator },
});

/**
 * One route inheriting the contract's mark, one likewise, and one overriding
 * it with a scheme of its own — the nearest-mark-wins fold, exercised end to
 * end across two distinct schemes. The middle key is "1", an integer-like
 * string, deliberately: JS reorders such a key ahead of every other own
 * property, so `htmx-controller.spec.ts`'s route-order assertion below is
 * also this fixture's own regression guard against that reordering leaking
 * into the composed `routes` array.
 */
const htmxFragments = authenticated({ user: [] })(
  defineFragments({
    orderRow: { method: "GET", path: "/orders/:id/row" },
    "1": { method: "GET", path: "/health" },
    adminOnly: authenticated({ service: [] })({ method: "GET", path: "/admin" }),
  }),
);

const orderRowFragment = htmxApi.HtmxController(htmxFragments, "orderRow")(
  { greeter: Greeter },
  {
    sync:
      ({ greeter }) =>
      (context, params) =>
        OkAsync(html`<tr>${greeter.greet(context.principal.userId)}:${params.id}</tr>`),
  },
);

const healthFragment = htmxApi.HtmxController(
  htmxFragments,
  "1",
)({
  sync: () => () => OkAsync(html`<p>ok</p>`),
});

const adminOnlyFragment = htmxApi.HtmxController(
  htmxFragments,
  "adminOnly",
)({
  sync: () => () => OkAsync(html`<p>admin</p>`),
});

const htmxFragmentsProvider = htmxApi.HtmxFragments(htmxFragments)([
  orderRowFragment,
  healthFragment,
  adminOnlyFragment,
]);

/** The composed port, built the way the kernel does — through a scoped graph — and read back. */
const htmxServiceOf = (): AsyncResult<ServiceOf<typeof HtmxFragmentsPort>, never> =>
  Module.scoped(
    Module("HtmxFixture")({
      provides: [
        Provider(Greeter)({ value: { greet: (name: string) => `hi ${name}` } }),
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

const htmxRowFragment = htmxRuntimeApi.HtmxGet("/orders/:id/row")({
  sync: () => (_context, params) => {
    htmxRowGetRuns += 1;
    return OkAsync(html`<tr id="row-${params.id}">row</tr>`);
  },
});

const htmxRowUpdateFragment = htmxRuntimeApi.HtmxPost("/orders/:id/row", { input: noteInput })({
  sync: () => (_context, params, input) => {
    htmxRowUpdateRuns += 1;
    return OkAsync(html`<tr id="row-${params.id}">${input.note}</tr>`);
  },
});

const htmxProfileFragment = htmxRuntimeApi.HtmxGet("/profile", { requires: [{ user: [] }] })({
  sync: () => (context) => OkAsync(html`<p>hi ${context.principal.userId}</p>`),
});

const htmxAdminPanelFragment = htmxRuntimeApi.HtmxGet("/admin", {
  requires: [{ user: ["admin"] }],
})({
  sync: () => () => OkAsync(html`<p>admin</p>`),
});

const htmxEchoFragment = htmxRuntimeApi.HtmxPost("/echo")({
  sync: () => (_context, _params, input) => OkAsync(html`<p>${JSON.stringify(input)}</p>`),
});

const htmxSecureFragment = htmxRuntimeApi.HtmxPost("/secure", { requires: [{ user: [] }] })({
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
          value: {
            port: 0,
            hostname: "127.0.0.1",
            bodyLimit: 0,
            corsOrigin: "",
            compression: false,
          },
        }),
        htmx(),
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
    unit?: SlowUnit["module"],
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
  /** A `StartOptions.unit` module whose provider builds only once `release()` is called. */
  readonly slowUnit: SlowUnit;
  /** An app started on an explicit port, for the failure paths. Shut down by the fixture. */
  readonly appOnPort: (port: number) => App;
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
  /** The pieces the composing router form takes, and what the unmarked router they build declares. */
  readonly controllers: {
    readonly controller: typeof helloController;
    readonly unmarkedRouterDeps: readonly string[];
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
  /** What each `HttpRouter` arm declares as its dependencies over the same marked contract. */
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
};

export const it = test.extend<HttpFixtures>({
  boot: bootFixture(),

  serve: async ({ boot }, use) => {
    await use(async (handler = noop, unit, securityHeaders) => {
      const app = boot(
        appOf(handler, undefined, securityHeaders),
        unit === undefined ? {} : { unit },
      );
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

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  slowUnit: async ({}, use) => {
    await use(slowUnitOf());
  },

  appOnPort: async ({ boot }, use) => {
    await use((port) => boot(appOf(noop, port)));
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

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  controllers: async ({}, use) => {
    await use({
      controller: helloController,
      unmarkedRouterDeps: slicedRouter.deps.map((dep) => dep.portId),
    });
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
      fromDeps: authedPositionalRouter.deps.map((dep) => dep.portId),
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
