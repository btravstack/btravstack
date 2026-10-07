import { authenticated } from "@btravstack/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type RouterContractClient } from "@orpc/contract";
import { openapi as route } from "@orpc/openapi";
import { OpenAPIReferenceHandlerPlugin } from "@orpc/openapi/plugins";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect } from "vitest";
import { z } from "zod";

import { it } from "./__tests__/test-fixtures.js";
import { HttpAuthenticator, Unauthenticated } from "./auth.js";
import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";
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
  provides: [openApiRoutes()],
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
  provides: [openApiRoutes()],
});
const documentApp = HttpModule("OpenApiDocument")({
  router: protectedRouter,
  port: 0,
  hostname: "127.0.0.1",
  provides: [
    openApiRoutes({
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
    }),
  ],
});

describe("OpenAPI routes", () => {
  it("does not expose resource paths from a document alone", async ({ boot }) => {
    const running = boot(rpcOnlyApp);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();
    const origin = `http://127.0.0.1:${info!.port}`;

    const get = await fetch(`${origin}/api/items/42`);
    const post = await fetch(`${origin}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "second" }),
    });

    expect([get.status, post.status]).toEqual([404, 404]);
  });

  it("serves conventional GET and POST requests described by the same contract", async ({
    boot,
  }) => {
    const running = boot(app);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();
    const origin = `http://127.0.0.1:${info!.port}`;

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

  it("keeps authentication and CSRF checks on the OpenAPI wire", async ({ boot }) => {
    const running = boot(protectedApp);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();
    const url = `http://127.0.0.1:${info!.port}/api/items`;
    const body = JSON.stringify({ name: "second" });
    const headers = { "content-type": "application/json", authorization: "Bearer good" };

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
    const running = boot(documentApp);
    const info = (await running.runtimeInfo()).get();
    expect(info).toBeDefined();

    const response = await fetch(`http://127.0.0.1:${info!.port}/api/spec.json`);
    const document = (await response.json()) as OpenApiDocument;

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
});
