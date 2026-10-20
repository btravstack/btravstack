import { Env } from "@btravstack/config";
import { authenticated } from "@btravstack/contract";
import { Module } from "@btravstack/di";
import {
  HttpAuthenticator,
  HttpHandler,
  HttpRuntime,
  Unauthenticated,
} from "@btravstack/http-server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type RouterContractClient } from "@orpc/contract";
import { openapi as route } from "@orpc/openapi";
import { OpenAPIReferenceHandlerPlugin } from "@orpc/openapi/plugins";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect, vi } from "vitest";
import { z } from "zod";

import { FORGED, GRANT, capabilityContract, it } from "./__tests__/test-fixtures.js";
import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";
import { http } from "./http.js";
import { openApiDocument, openApiRoutes, type OpenApiDocument } from "./openapi.js";

const item = z.object({ id: z.string(), name: z.string() });
const contract = {
  items: {
    find: oc
      .meta(route({ method: "GET", path: "/items/{id}" }))
      .input(z.object({ id: z.string() }))
      .output(item),
    create: oc
      .meta(route({ method: "POST", path: "/items" }))
      .input(z.object({ name: z.string() }))
      .output(item),
  },
};

const api = defineHttp();
const router = api.OrpcRouter(contract)({
  inject: {},
  sync: () => ({
    items: {
      find: (_context, input) => OkAsync({ id: input.id, name: "first" }),
      create: (_context, input) => OkAsync({ id: "42", name: input.name }),
    },
  }),
});

const app = HttpModule("OpenApiRoutes")({
  router,
  port: 0,
  hostname: "127.0.0.1",
  openapi: true,
});
const localPolicyApp = HttpModule("OpenApiLocalPolicy")({
  router,
  port: 0,
  hostname: "127.0.0.1",
  bodyLimit: false,
  openapi: { compression: true },
});
const handRolledApp = Module("OpenApiHandRolled")({
  needs: [Env],
  imports: [http({ port: 0, hostname: "127.0.0.1" })],
  provides: [router, openApiRoutes()],
  exports: [HttpRuntime, HttpHandler],
});
const modulePolicyApp = HttpModule("OpenApiModulePolicy")({
  router,
  port: 0,
  hostname: "127.0.0.1",
  cors: true,
  openapi: true,
});
const rpcOnlyApp = HttpModule("RpcOnly")({
  router,
  port: 0,
  hostname: "127.0.0.1",
});

const userAuth = HttpAuthenticator<{ readonly name: string }>()({
  inject: {},
  sync: () => (headers) =>
    headers.authorization === "Bearer good"
      ? OkAsync({ name: "Ada" })
      : ErrAsync(new Unauthenticated()),
});
const protectedApi = defineHttp({ authenticators: { user: userAuth } });
const protectedContract = {
  items: authenticated({ user: [] })({
    create: oc
      .meta(route({ method: "POST", path: "/items" }))
      .input(z.object({ name: z.string() }))
      .output(item),
  }),
};
const protectedRouter = protectedApi.OrpcRouter(protectedContract)({
  inject: {},
  sync: () => ({
    items: {
      create: ({ context }, input) => OkAsync({ id: context.principal.name, name: input.name }),
    },
  }),
});
const protectedApp = HttpModule("ProtectedOpenApiRoutes")({
  router: protectedRouter,
  port: 0,
  hostname: "127.0.0.1",
  csrf: true,
  openapi: true,
});
const documentApp = HttpModule("OpenApiDocument")({
  router: protectedRouter,
  port: 0,
  hostname: "127.0.0.1",
  openapi: {
    plugins: [
      new OpenAPIReferenceHandlerPlugin({
        spec: async () =>
          (
            await openApiDocument(protectedContract, {
              securitySchemes: { user: { type: "http", scheme: "bearer" } },
            })
          ).get(),
      }),
    ],
  },
});

describe("OpenAPI routes", () => {
  it("does not expose resource paths from a document alone", async ({ boot }) => {
    // Given an HTTP module without the OpenAPI answerer.
    const running = boot(rpcOnlyApp);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();
    const origin = `http://127.0.0.1:${info!.port}`;

    // When clients request the contract's resource paths.
    const get = await fetch(`${origin}/api/items/42`);
    const post = await fetch(`${origin}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "second" }),
    });

    // Then neither path is served.
    expect([get.status, post.status]).toEqual([404, 404]);
  });

  it("serves conventional GET and POST requests described by the same contract", async ({
    boot,
  }) => {
    // Given one contract mounted for RPC and OpenAPI routes.
    const running = boot(app);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();
    const origin = `http://127.0.0.1:${info!.port}`;

    // When clients use both routes and generate the OpenAPI document.
    const before = await fetch(`${origin}/api/items/42`);
    const created = await fetch(`${origin}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "second" }),
    });
    const rpc: RouterContractClient<typeof contract> = createORPCClient(
      new RPCLink({ origin, url: "/rpc" }),
    );
    const document = (await openApiDocument(contract)).get();

    // Then the routes and document describe the same operations.
    expect({
      get: [before.status, await before.json()],
      post: [created.status, await created.json()],
      rpc: await rpc.items.find({ id: "42" }),
      paths: Object.keys(document.paths ?? {}),
      methods: [
        Object.keys(document.paths?.["/items/{id}"] ?? {}),
        Object.keys(document.paths?.["/items"] ?? {}),
      ],
    }).toEqual({
      get: [200, { id: "42", name: "first" }],
      post: [200, { id: "42", name: "second" }],
      rpc: { id: "42", name: "first" },
      paths: ["/items/{id}", "/items"],
      methods: [["get"], ["post"]],
    });
  });

  it("honors a body limit disabled on the HTTP module", async ({ boot }) => {
    // Given a module with its body limit disabled.
    const running = boot(localPolicyApp);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();
    const name = "x".repeat(1_100_000);

    // When a request exceeds the module's default limit.
    const response = await fetch(`http://127.0.0.1:${info!.port}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });

    // Then the answerer accepts the full body.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42", name });
  });

  it("honors response compression enabled on the OpenAPI answerer", async ({ boot }) => {
    // Given an answerer with local compression enabled.
    const running = boot(localPolicyApp);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();

    // When the client accepts gzip for a compressible response.
    const response = await fetch(`http://127.0.0.1:${info!.port}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: JSON.stringify({ name: "x".repeat(2048) }),
    });

    // Then the response is compressed.
    expect([response.status, response.headers.get("content-encoding")]).toEqual([200, "gzip"]);
  });

  it("serves OpenAPI routes from a root composed with http()", async ({ boot }) => {
    // GIVEN a root that composes `http()` and `openApiRoutes()` itself
    const info = (await boot(handRolledApp).runtimeInfo()).get();

    // WHEN a client calls an OpenAPI route
    const response = await fetch(`http://127.0.0.1:${info?.port}/api/items/42`);

    // THEN the route is served
    expect([response.status, await response.json()]).toEqual([200, { id: "42", name: "first" }]);
  });

  it("takes the module's own cors when the option pins none", async ({ boot }) => {
    // GIVEN `cors: true` on the module and `openapi: true`
    const info = (await boot(modulePolicyApp).runtimeInfo()).get();

    // WHEN a cross-origin client calls an OpenAPI route
    const response = await fetch(`http://127.0.0.1:${info?.port}/api/items/42`, {
      headers: { origin: "https://caller.test" },
    });

    // THEN the answerer reflects the caller's origin, as the RPC answerer does
    expect([response.status, response.headers.get("access-control-allow-origin")]).toEqual([
      200,
      "https://caller.test",
    ]);
  });

  it("keeps authentication and CSRF checks on the OpenAPI wire", async ({ boot }) => {
    // Given protected OpenAPI routes.
    const running = boot(protectedApp);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();
    const url = `http://127.0.0.1:${info!.port}/api/items`;
    const body = JSON.stringify({ name: "second" });
    const headers = { "content-type": "application/json", authorization: "Bearer good" };

    // When requests omit credentials, cross sites, or meet both checks.
    const missing = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const crossSite = await fetch(url, {
      method: "POST",
      headers: { ...headers, cookie: "session=ambient", origin: "https://other.test" },
      body,
    });
    const accepted = await fetch(url, { method: "POST", headers, body });

    // Then only the authorized same-site request succeeds.
    expect([missing.status, crossSite.status, accepted.status, await accepted.json()]).toEqual([
      401,
      403,
      200,
      { id: "Ada", name: "second" },
    ]);
  });

  it("serves an explicitly mounted spec with the contract's security requirements", async ({
    boot,
  }) => {
    // Given a spec explicitly mounted from the protected contract.
    const running = boot(documentApp);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();

    // When a client requests the spec.
    const response = await fetch(`http://127.0.0.1:${info!.port}/api/spec.json`);
    const document = (await response.json()) as OpenApiDocument;

    // Then the document carries the contract's security requirements.
    expect({
      status: response.status,
      security: document.paths?.["/items"]?.post?.security,
      scheme: document.components?.securitySchemes?.["user"],
    }).toEqual({
      status: 200,
      security: [{ user: [] }],
      scheme: { type: "http", scheme: "bearer" },
    });
  });
  it("keeps a capability URL's unit open until its streamed answer is flushed", async ({
    capability,
  }) => {
    // GIVEN a file served behind a grant in its URL, streamed from the unit
    const origin = await capability.serve();

    // WHEN a client follows the link, receives the headers, then lets the rest stream
    const response = await fetch(`${origin}/api/files/42?grant=${GRANT}`);
    capability.log.push("headers received");
    capability.release();
    const body = await response.text();
    await vi.waitUntil(() => capability.log.includes("unit closed"));

    // THEN the unit outlived the handler and closed once the answer was flushed
    expect({ status: response.status, body, log: capability.log }).toEqual({
      status: 200,
      body: "42;last",
      log: ["handler answered", "headers received", "streamed in an open unit", "unit closed"],
    });
  });

  it("answers a refused grant 403 and a missing one 401, echoing and reporting no grant", async ({
    capability,
  }) => {
    // GIVEN the capability app, its download free to stream
    const origin = await capability.serve();
    capability.release();

    // WHEN one client presents no grant, one a forged grant and one a valid grant
    const missing = await fetch(`${origin}/api/files/42`);
    const refused = await fetch(`${origin}/api/files/42?grant=${FORGED}`);
    const accepted = await fetch(`${origin}/api/files/42?grant=${GRANT}`);
    const bodies = [await missing.text(), await refused.text(), await accepted.text()];
    await vi.waitUntil(() => capability.log.includes("unit closed"));

    // THEN the statuses tell absent from refused, and no answer or report carries a grant
    expect({
      statuses: [missing.status, refused.status, accepted.status],
      refusals: bodies.slice(0, 2).join(),
      observed: JSON.stringify(capability.observed),
    }).toEqual({
      statuses: [401, 403, 200],
      refusals: expect.not.stringMatching(/payload/),
      observed: expect.not.stringMatching(/payload/),
    });
  });

  it("documents a capability URL's scheme as an apiKey in the query", async () => {
    // GIVEN the contract marked with the grant scheme, described as OpenAPI's query apiKey
    const securitySchemes = { grant: { type: "apiKey", in: "query", name: "grant" } } as const;

    // WHEN its document is generated
    const document = (await openApiDocument(capabilityContract, { securitySchemes })).get();

    // THEN the operation requires the scheme, and the scheme is read from the query
    expect({
      security: document.paths?.["/files/{id}"]?.get?.security,
      scheme: document.components?.securitySchemes?.["grant"],
    }).toEqual({
      security: [{ grant: [] }],
      scheme: { type: "apiKey", in: "query", name: "grant" },
    });
  });
});
