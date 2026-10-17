import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import { Env } from "@btravstack/config";
import { Observers, start, type Operation, type RunningApp, type Settled } from "@btravstack/core";
import { Module, Port, Provider, type AnyProvider } from "@btravstack/di";
import {
  HttpAuthenticator,
  Unauthenticated,
  apiKeyAuthenticator,
  defineAuth,
  protectedResource,
  granted,
} from "@btravstack/http-server";
import { HttpHandler, HttpRuntime, httpServer } from "@btravstack/http-server/internal";
import { bootFixture, type Boot } from "@btravstack/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrAsync, OkAsync } from "unthrown";
import { test } from "vitest";
import { z } from "zod";

import { ToolRefused, mcp } from "../mcp.js";

/** One operation an observer was handed, with how it settled. */
export type Observation = { readonly operation: Operation; settled?: Settled };

/** `k-1` may call tools; `k-2` is a valid key granted nothing. */
const auth = defineAuth({
  authenticators: {
    service: apiKeyAuthenticator<{ readonly appId: string }>()({
      keys: [
        { key: "k-1", principal: { appId: "a-1" }, scopes: ["tools:call"] },
        { key: "k-2", principal: { appId: "a-2" } },
      ],
    }),
  },
});

/** A scheme whose verification is a defect, not a refusal. */
const brokenAuth = defineAuth({
  authenticators: {
    service: HttpAuthenticator<{ readonly appId: string }>()({
      inject: {},
      sync: () => () =>
        OkAsync({ appId: "never" }).map(() => {
          // oxlint-disable-next-line unthrown/no-throw -- the subject under test: an authenticator's defect
          throw new Error("authenticator-boom");
        }),
    }),
  },
});

class Message extends Port("McpMessage")<string> {}

const unit = Module("McpUnit")({
  provides: [Provider(Message)({ inject: {}, value: "inside unit" })],
  exports: [Message],
});

/** A unit whose one service cannot be built, so the fork itself is a defect. */
const brokenUnit = Module("BrokenMcpUnit")({
  provides: [
    Provider(Message)({
      inject: {},
      sync: () => {
        // oxlint-disable-next-line unthrown/no-throw -- the subject under test: a fork's construction failure
        throw new Error("construction-boom");
      },
    }),
  ],
  exports: [Message],
});

const protectedAnswerer = mcp(auth, {
  requires: [{ service: ["tools:call"] }],
  units: { service: unit },
  unit: { message: Message },
  server: ({ principal, unit: services, toolResult }) => {
    const server = new McpServer({ name: "fixture", version: "1.0.0" });
    server.registerTool("whoami", { inputSchema: {} }, () => toolResult(OkAsync(principal.appId)));
    server.registerTool("order", { inputSchema: { id: z.string() } }, ({ id }) =>
      toolResult(OkAsync({ id, quantity: 2 })),
    );
    server.registerTool("count", { inputSchema: {} }, () => toolResult(OkAsync([1, 2])));
    server.registerTool("epoch", { inputSchema: {} }, () => toolResult(OkAsync(new Date(0))));
    server.registerTool("huge", { inputSchema: {} }, () => toolResult(OkAsync(1n)));
    server.registerTool("nothing", { inputSchema: {} }, () => toolResult(OkAsync(undefined)));
    server.registerTool("hostile", { inputSchema: {} }, () =>
      toolResult(
        OkAsync({
          toJSON: () => undefined,
          toString: () => {
            // oxlint-disable-next-line unthrown/no-throw -- the subject under test: a value whose coercion throws
            throw new Error("coercion-boom");
          },
        }),
      ),
    );
    server.registerTool("greet", { inputSchema: {} }, () => toolResult(OkAsync(services.message)));
    server.registerTool("refuse", { inputSchema: {} }, () =>
      toolResult(ErrAsync(new ToolRefused({ text: "not yours" }))),
    );
    server.registerTool("crash", { inputSchema: {} }, () =>
      toolResult(
        OkAsync("never").map(() => {
          // oxlint-disable-next-line unthrown/no-throw -- the only way to mint a defect is a throw inside a combinator
          throw new Error("the secret cause");
        }),
      ),
    );
    return server;
  },
});

/** No requirement, mounted elsewhere: whoever calls is nobody in particular. */
const publicAnswerer = mcp(defineAuth(), {
  prefix: "/agents",
  server: ({ principal, toolResult }) => {
    const server = new McpServer({ name: "public", version: "1.0.0" });
    server.registerTool("whoami", { inputSchema: {} }, () =>
      toolResult(OkAsync(String(principal))),
    );
    return server;
  },
});

const brokenSchemeAnswerer = mcp(brokenAuth, {
  requires: [{ service: [] }],
  server: () => new McpServer({ name: "never", version: "1.0.0" }),
});

const brokenUnitAnswerer = mcp(auth, {
  requires: [{ service: [] }],
  units: { service: brokenUnit },
  unit: { message: Message },
  server: () => new McpServer({ name: "never", version: "1.0.0" }),
});

/** A server whose `close` rejects, the cleanup failure the answerer reports. */
class UnclosableServer extends McpServer {
  override close(): Promise<void> {
    return Promise.reject(new Error("close-boom"));
  }
}

const unclosableAnswerer = mcp(auth, {
  requires: [{ service: [] }],
  server: () => new UnclosableServer({ name: "unclosable", version: "1.0.0" }),
});

const deployments = {
  bearer: (() => {
    const api = defineAuth({
      authenticators: {
        service: HttpAuthenticator<{}, "tools:call">()({
          bearer: true,
          inject: {},
          sync: () => (headers) =>
            headers.authorization === "Bearer k-2"
              ? OkAsync(granted({}, [] as readonly "tools:call"[]))
              : ErrAsync(new Unauthenticated()),
        }),
      },
    });
    return {
      answerer: mcp(api, {
        requires: [{ service: ["tools:call"] }],
        server: () => new McpServer({ name: "never", version: "1" }),
      }),
      providers: api.providers,
      unit,
      path: "/mcp",
    };
  })(),
  protected: { answerer: protectedAnswerer, providers: auth.providers, unit, path: "/mcp" },
  public: { answerer: publicAnswerer, providers: [], unit, path: "/agents" },
  brokenScheme: {
    answerer: brokenSchemeAnswerer,
    providers: brokenAuth.providers,
    unit,
    path: "/mcp",
  },
  brokenUnit: {
    answerer: brokenUnitAnswerer,
    providers: auth.providers,
    unit: brokenUnit,
    path: "/mcp",
  },
  unclosable: { answerer: unclosableAnswerer, providers: auth.providers, unit, path: "/mcp" },
} as const;

type Deployment = keyof typeof deployments;

const appOf = (deployment: Deployment, bodyLimit: number | undefined, seen: Observation[]) => {
  const { answerer, providers, unit: bound } = deployments[deployment];
  return Module("McpApp")({
    needs: [Env],
    imports: [
      httpServer({
        port: 0,
        hostname: "127.0.0.1",
        unit: { service: bound },
        ...(bodyLimit === undefined ? {} : { bodyLimit }),
      }),
    ],
    provides: [
      answerer as AnyProvider,
      ...(providers as readonly AnyProvider[]),
      ...protectedResource({
        resource: "https://api.test/mcp",
        authorizationServers: ["https://login.test/"],
      }),
      Provider.member(Observers)({
        inject: {},
        value: (operation: Operation) => {
          const observation: Observation = { operation };
          seen.push(observation);
          return (settled: Settled) => {
            observation.settled = settled;
          };
        },
      }),
    ],
    exports: [HttpRuntime, HttpHandler],
  });
};

/** The `initialize` request a client opens with, sent bare so its status can be read. */
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  },
};

export type Served = {
  /** An SDK client connected with this key, or none, closed by the fixture. */
  readonly connect: (key?: string) => Promise<Client>;
  /** One raw request to the mount — a POST unless `method` says otherwise — with this key or none, carrying `body`, as `api.test`. */
  readonly post: (
    key?: string,
    body?: unknown,
    method?: string,
  ) => Promise<{ readonly status: number; readonly challenge: string | null }>;
  readonly seen: readonly Observation[];
};

type McpFixtures = {
  readonly boot: Boot;
  /**
   * One deployment on an ephemeral port, over whatever body limit a test pins:
   * `protected` requires the `service` scheme and composes everything,
   * `public` requires nothing at `/agents`, `brokenScheme` and
   * `brokenUnit` fail in their scheme and in their fork, and `unclosable`'s
   * server rejects its `close`.
   */
  readonly served: (options?: {
    readonly deployment?: Deployment;
    readonly bodyLimit?: number;
  }) => Promise<Served>;
  /**
   * An answerer declaring one unit module while the runtime binds another,
   * booted; the boot is the test's to assert on `app.exited`.
   */
  readonly mismatched: RunningApp<unknown, unknown>;
};

export const it = test.extend<McpFixtures>({
  boot: bootFixture(),

  served: async ({ boot }, use) => {
    const clients: Client[] = [];
    await use(async ({ deployment = "protected", bodyLimit } = {}) => {
      const seen: Observation[] = [];
      const info = (await boot(appOf(deployment, bodyLimit, seen)).runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const url = new URL(`http://127.0.0.1:${info.port}${deployments[deployment].path}`);
      const headers = (key: string | undefined) =>
        key === undefined
          ? {}
          : deployment === "bearer"
            ? { authorization: `Bearer ${key}` }
            : { "x-api-key": key };
      return {
        seen,
        connect: async (key) => {
          const client = new Client({ name: "spec", version: "1.0.0" });
          clients.push(client);
          const transport = new StreamableHTTPClientTransport(url, {
            requestInit: { headers: headers(key) },
          });
          // The SDK's own declarations disagree under `exactOptionalPropertyTypes`.
          await client.connect(transport as unknown as Transport);
          return client;
        },
        // `node:http` rather than `fetch`, which refuses to name the `Host`
        // the protected resource is identified by.
        post: (key, body = INITIALIZE, method = "POST") =>
          new Promise((done, failed) => {
            const request = httpRequest(
              {
                method,
                host: url.hostname,
                port: url.port,
                path: url.pathname,
                headers: {
                  host: "api.test",
                  accept: "application/json, text/event-stream",
                  "content-type": "application/json",
                  ...headers(key),
                },
              },
              (response) => {
                response.resume();
                response.on("end", () =>
                  done({
                    status: response.statusCode ?? 0,
                    challenge: response.headers["www-authenticate"] ?? null,
                  }),
                );
              },
            );
            request.on("error", failed);
            request.end(JSON.stringify(body));
          }),
      };
    });
    await Promise.all(clients.map((client) => client.close()));
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  mismatched: async ({}, use) => {
    const declared = Module("DeclaredMcpUnit")({
      provides: [Provider(Message)({ inject: {}, value: "declared" })],
      exports: [Message],
    });
    const answerer = mcp(defineAuth(), {
      units: { anonymous: declared },
      unit: { message: Message },
      server: () => new McpServer({ name: "never", version: "1.0.0" }),
    });
    const app = start(
      Module("MismatchedMcpUnit")({
        needs: [Env],
        imports: [httpServer({ port: 0, hostname: "127.0.0.1", unit: { anonymous: unit } })],
        provides: [answerer],
        exports: [HttpRuntime, HttpHandler],
      }),
      { signals: false, probes: false },
    );
    await use(app as RunningApp<unknown, unknown>);
    app.stop();
    await app.exited;
  },
});
