import { start } from "@btravstack/core";
import { Observers, type Settled } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { HttpAuthenticator, Unauthenticated, granted } from "@btravstack/http-server";
import { defineAuth } from "@btravstack/http-server";
import { HttpHandler } from "@btravstack/http-server/internal";
import { HttpRuntime, httpServer } from "@btravstack/http-server/internal";
import { it } from "@btravstack/internal-http-fixtures";
import type { GraphQLError } from "graphql";
import { createGraphQLError, createSchema, type Plugin } from "graphql-yoga";
import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";
import { describe, expect, vi } from "vitest";

import { fieldResult } from "./field.js";
import { graphql } from "./graphql.js";

describe("graphql answerer", () => {
  it("serves a query through the existing HTTP runtime", async ({ boot }) => {
    // GIVEN a GraphQL schema mounted beside the HTTP runtime
    const schema = createSchema({
      typeDefs: "type Query { hello: String }",
      resolvers: { Query: { hello: () => "world" } },
    });
    const answerer = graphql(defineAuth(), { schema });
    const app = boot(
      Module("GraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
        provides: [answerer],
        exports: [HttpRuntime, HttpHandler],
      }),
    );
    const info = (await app.runtimeInfo()).get();
    expect(info).toBeDefined();

    // WHEN a GraphQL query reaches that mount
    const response = await fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ hello }" }),
    });

    // THEN Yoga answers it inside the existing listener
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { data: { hello: "world" } },
    });
  });

  it("keeps CORS closed by default and honors the configured origin", async ({ boot }) => {
    // GIVEN a closed server, an allowed origin and a credentialed origin
    const schema = createSchema({
      typeDefs: "type Query { hello: String }",
      resolvers: { Query: { hello: () => "world" } },
    });
    const app = (corsOrigin?: string, credentials = false) =>
      boot(
        Module("CorsGraphqlApp")({
          imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
          provides: [
            graphql(
              defineAuth(),
              credentials
                ? { schema, cors: { origin: "https://web.example", credentials: true } }
                : { schema },
            ),
          ],
          exports: [HttpRuntime, HttpHandler],
        }),
        { env: corsOrigin === undefined ? {} : { HTTP_CORS_ORIGIN: corsOrigin } },
      );
    const closed = app();
    const allowed = app("https://web.example");
    const credentialed = app(undefined, true);
    const closedPort = (await closed.runtimeInfo()).get()!.port;
    const allowedPort = (await allowed.runtimeInfo()).get()!.port;
    const credentialedPort = (await credentialed.runtimeInfo()).get()!.port;
    const preflight = (port: number) =>
      fetch(`http://127.0.0.1:${port}/graphql`, {
        method: "OPTIONS",
        headers: {
          origin: "https://web.example",
          "access-control-request-method": "POST",
        },
      });

    // WHEN the browser preflights each GraphQL mount
    const closedPreflight = await preflight(closedPort);
    const allowedPreflight = await preflight(allowedPort);
    const credentialedPreflight = await preflight(credentialedPort);

    // THEN each mount applies its configured CORS policy
    expect({
      closed: closedPreflight.headers.get("access-control-allow-origin"),
      allowed: allowedPreflight.headers.get("access-control-allow-origin"),
      credentials: credentialedPreflight.headers.get("access-control-allow-credentials"),
    }).toEqual({ closed: null, allowed: "https://web.example", credentials: "true" });
  });

  it("normalizes a trailing slash and accepts Yoga plugins", async ({ boot }) => {
    let parsed = false;
    const schema = createSchema({
      typeDefs: "type Query { hello: String }",
      resolvers: { Query: { hello: () => "world" } },
    });
    const app = boot(
      Module("CustomGraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
        provides: [
          graphql(defineAuth(), {
            schema,
            prefix: "/graph/",
            plugins: [
              {
                onParse: () => {
                  parsed = true;
                },
              },
            ],
          }),
        ],
        exports: [HttpRuntime, HttpHandler],
      }),
    );
    const port = (await app.runtimeInfo()).get()!.port;
    const response = await fetch(`http://127.0.0.1:${port}/graph`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ hello }" }),
    });

    expect({ body: await response.json(), parsed }).toEqual({
      body: { data: { hello: "world" } },
      parsed: true,
    });
  });

  it("forks the request scope before executing a resolver", async ({ boot }) => {
    // GIVEN a resolver that reads a unit-scoped service and the cancellation signal
    class Message extends Port("GraphqlMessage")<string> {}
    const unit = Module("GraphqlUnit")({
      provides: [Provider(Message)({ inject: {}, value: "inside unit" })],
      exports: [Message],
    });
    const schema = createSchema({
      typeDefs: "type Query { message: String! }",
      resolvers: {
        Query: {
          message: (_parent, _args, context: { unit: { message: string }; signal: AbortSignal }) =>
            `${context.unit.message}:${context.signal.aborted}`,
        },
      },
    });
    const answerer = graphql(defineAuth(), {
      schema,
      units: { anonymous: unit },
      unit: { message: Message },
    });
    const app = boot(
      Module("ScopedGraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1", unit: { anonymous: unit } })],
        provides: [answerer],
        exports: [HttpRuntime, HttpHandler],
      }),
    );
    const info = (await app.runtimeInfo()).get();
    expect(info).toBeDefined();

    // WHEN a GraphQL query executes
    const response = await fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ message }" }),
    });

    // THEN its resolver sees the service from this request's fork
    expect(await response.json()).toEqual({ data: { message: "inside unit:false" } });
  });

  it("refuses a protected GraphQL mount before executing its resolver", async ({ boot }) => {
    // GIVEN a protected GraphQL schema whose only credential is Bearer good
    let invoked = false;
    let authenticated = 0;
    const user = HttpAuthenticator<{ userId: string }>()({
      inject: {},
      sync: () => (headers) => {
        authenticated++;
        return headers.authorization === "Bearer good"
          ? OkAsync({ userId: "u-1" })
          : ErrAsync(new Unauthenticated());
      },
    });
    const api = defineAuth({ authenticators: { user } });
    const schema = createSchema({
      typeDefs: "type Query { secret: String! }",
      resolvers: {
        Query: {
          secret: (_parent, _args, context: { principal: { userId: string } }) => {
            invoked = true;
            return context.principal.userId;
          },
        },
      },
    });
    const answerer = graphql(api, { schema, requires: [{ user: [] }] });
    const app = boot(
      Module("ProtectedGraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
        provides: [answerer, ...answerer.authenticators],
        exports: [HttpRuntime, HttpHandler],
      }),
      { env: { HTTP_CORS_ORIGIN: "https://web.example" } },
    );
    const info = (await app.runtimeInfo()).get();

    // WHEN a browser preflights, then callers request the protected field
    const preflight = await fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "OPTIONS",
      headers: {
        origin: "https://web.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    const authenticatedBefore = authenticated;
    const response = await fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://web.example" },
      body: JSON.stringify({ query: "{ secret }" }),
    });
    const accepted = await fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer good" },
      body: JSON.stringify({ query: "{ secret }" }),
    });

    // THEN the shared auth seam refuses it without invoking GraphQL
    expect({
      preflight: {
        status: preflight.status,
        origin: preflight.headers.get("access-control-allow-origin"),
        authenticated: authenticatedBefore,
      },
      refused: {
        status: response.status,
        origin: response.headers.get("access-control-allow-origin"),
      },
      accepted: await accepted.json(),
      invoked,
    }).toEqual({
      preflight: { status: 204, origin: "https://web.example", authenticated: 0 },
      refused: { status: 401, origin: "https://web.example" },
      accepted: { data: { secret: "u-1" } },
      invoked: true,
    });
  });

  it("distinguishes a missing scope from a broken authenticator", async ({ boot }) => {
    // GIVEN a scheme that can grant read, but holds no scope or fails unexpectedly
    const user = HttpAuthenticator<{ userId: string }, "read">()({
      inject: {},
      sync: () => (headers) =>
        headers.authorization === "Bearer broken"
          ? fromSafePromise(Promise.reject(new Error("verifier broke")))
          : OkAsync(granted({ userId: "u-1" }, [] as readonly "read"[])),
    });
    const api = defineAuth({ authenticators: { user } });
    const answerer = graphql(api, {
      schema: createSchema({
        typeDefs: "type Query { secret: String! }",
        resolvers: { Query: { secret: () => "secret" } },
      }),
      requires: [{ user: ["read"] }],
      cors: { origin: ["https://web.example", "https://other.example"], credentials: false },
    });
    const app = boot(
      Module("ScopedGraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
        provides: [answerer, ...answerer.authenticators],
        exports: [HttpRuntime, HttpHandler],
      }),
    );
    const info = (await app.runtimeInfo()).get();
    const url = `http://127.0.0.1:${info!.port}/graphql`;
    const send = (authorization: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization,
          origin: "https://web.example",
        },
        body: JSON.stringify({ query: "{ secret }" }),
      });

    // WHEN each credential requests the mount
    const denied = await send("Bearer under-scoped");
    const broken = await send("Bearer broken");

    // THEN scope refusal is 403 and the authenticator defect is a runtime 500
    expect({
      denied: {
        status: denied.status,
        origin: denied.headers.get("access-control-allow-origin"),
        credentials: denied.headers.get("access-control-allow-credentials"),
      },
      broken: broken.status,
    }).toEqual({
      denied: { status: 403, origin: "https://web.example", credentials: null },
      broken: 500,
    });
  });

  it("answers 500 when its request unit cannot be built", async ({ boot }) => {
    // GIVEN a unit-scoped provider whose construction fails
    class Broken extends Port("BrokenGraphqlUnit")<string> {}
    const unit = Module("BrokenGraphqlUnit")({
      provides: [
        Provider(Broken)({
          inject: {},
          sync: () => {
            // oxlint-disable-next-line unthrown/no-throw -- test the fork's defect path
            throw new Error("unit failed");
          },
        }),
      ],
      exports: [Broken],
    });
    const answerer = graphql(defineAuth(), {
      schema: createSchema({
        typeDefs: "type Query { hello: String! }",
        resolvers: { Query: { hello: () => "hello" } },
      }),
      units: { anonymous: unit },
    });
    const app = boot(
      Module("BrokenGraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1", unit: { anonymous: unit } })],
        provides: [answerer],
        exports: [HttpRuntime, HttpHandler],
      }),
    );
    const info = (await app.runtimeInfo()).get();

    // WHEN GraphQL attempts to open that unit
    const response = await fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ hello }" }),
    });

    // THEN the runtime owns the defect response
    expect(response.status).toBe(500);
  });

  it("refuses a unit declaration that differs from the runtime binding", async () => {
    // GIVEN a GraphQL unit declaration that differs from the runtime's module
    class Message extends Port("GraphqlBoundMessage")<string> {}
    const bound = Module("BoundGraphqlUnit")({
      provides: [Provider(Message)({ inject: {}, value: "bound" })],
      exports: [Message],
    });
    const declared = Module("DeclaredGraphqlUnit")({
      provides: [Provider(Message)({ inject: {}, value: "declared" })],
      exports: [Message],
    });
    const answerer = graphql(defineAuth(), {
      schema: createSchema({
        typeDefs: "type Query { message: String! }",
        resolvers: { Query: { message: () => "message" } },
      }),
      units: { anonymous: declared },
      unit: { message: Message },
    });
    const app = start(
      Module("MismatchedGraphqlUnit")({
        imports: [httpServer({ unit: { anonymous: bound } })],
        provides: [answerer],
        exports: [HttpRuntime, HttpHandler],
      }),
      { signals: false, probes: false },
    );

    // WHEN the application boots
    // THEN DI reports the mismatched unit binding
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message: '[graphql-server] unit kind "anonymous" differs from HttpUnit',
      }),
    );
  });

  it("disposes Yoga plugins when the application stops", async ({ boot }) => {
    // GIVEN a Yoga plugin with a disposal hook
    let disposals = 0;
    const answerer = graphql(defineAuth(), {
      schema: createSchema({
        typeDefs: "type Query { hello: String! }",
        resolvers: { Query: { hello: () => "hello" } },
      }),
      plugins: [
        {
          onDispose: () => {
            disposals++;
          },
        },
      ],
    });
    const app = boot(
      Module("DisposableGraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
        provides: [answerer],
        exports: [HttpRuntime, HttpHandler],
      }),
    );
    await app.runtimeInfo();

    // WHEN the application stops
    app.stop();
    await app.exited;

    // THEN the plugin is disposed once
    expect(disposals).toBe(1);
  });

  it("keeps a resolver failure inside GraphQL's error envelope", async ({ boot }) => {
    // GIVEN an application resolver that fails unexpectedly
    const schema = createSchema({
      typeDefs: "type Query { broken: String }",
      resolvers: {
        Query: {
          broken: () => {
            // oxlint-disable-next-line unthrown/no-throw -- exercise Yoga's masking of an unexpected resolver failure
            throw new Error("private detail");
          },
        },
      },
    });
    const answerer = graphql(defineAuth(), { schema });
    const app = boot(
      Module("FailingGraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
        provides: [answerer],
        exports: [HttpRuntime, HttpHandler],
      }),
    );
    const info = (await app.runtimeInfo()).get();

    // WHEN a client executes it
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ broken }" }),
    });

    // THEN Yoga masks the error while the process remains serving
    const body = (await response.json()) as { errors: Array<{ message: string }> };
    expect({
      status: response.status,
      message: body.errors[0]?.message,
      phase: app.phase(),
      logged: logged.mock.calls.some((args) =>
        args.some((arg) => String(arg).includes("private detail")),
      ),
    }).toEqual({ status: 200, message: "Unexpected error.", phase: "serving", logged: false });
    logged.mockRestore();
  });

  it("drains an in-flight GraphQL operation as one HTTP unit", async ({ boot }) => {
    // GIVEN a resolver held open after the request reaches it
    let arrived!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const schema = createSchema({
      typeDefs: "type Query { held: String! }",
      resolvers: {
        Query: {
          held: async () => {
            arrived();
            await held;
            return "done";
          },
        },
      },
    });
    const answerer = graphql(defineAuth(), { schema });
    const app = boot(
      Module("DrainingGraphqlApp")({
        imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
        provides: [answerer],
        exports: [HttpRuntime, HttpHandler],
      }),
    );
    const info = (await app.runtimeInfo()).get();
    const inFlight = fetch(`http://127.0.0.1:${info!.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ held }" }),
    });
    await entered;

    // WHEN shutdown begins and the resolver settles
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    release();
    await inFlight;

    // THEN the kernel accounts for the operation before exit
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({
        drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
      }),
    );
  });
});

describe("fieldResult", () => {
  const schema = createSchema({
    typeDefs: `
      type Query { order(id: String!): String, orders(ids: [String!]!): [String] }
      type Subscription { placed: String }
    `,
    resolvers: {
      Subscription: {
        placed: {
          subscribe: async function* () {
            yield "1";
            yield "refused";
          },
          resolve: (id: string) => fieldResult(lookup(id)),
        },
      },
      Query: {
        order: (_parent: unknown, { id }: { id: string }) => fieldResult(lookup(id)),
        orders: (_parent: unknown, { ids }: { ids: readonly string[] }) =>
          ids.map((id) => fieldResult(lookup(id))),
      },
    },
  });
  const lookup = (id: string): AsyncResult<string, GraphQLError> =>
    id === "refused"
      ? ErrAsync(createGraphQLError("not yours", { extensions: { code: "FORBIDDEN" } }))
      : id === "caused"
        ? ErrAsync(
            createGraphQLError("not yours either", {
              extensions: { code: "FORBIDDEN" },
              originalError: new Error("the service's own reason"),
            }),
          )
        : id === "broken"
          ? fromSafePromise(Promise.reject(new Error("database password in this message")))
          : id === "leaky"
            ? fromSafePromise(Promise.reject(createGraphQLError("internal hostname db-7")))
            : OkAsync(`order ${id}`);
  const appWith = (seen: Settled[], plugins: readonly Plugin[] = []) =>
    Module("FieldResultApp")({
      imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
      provides: [
        graphql(defineAuth(), { schema, plugins }),
        Provider.member(Observers)({
          inject: {},
          sync: () => (operation) => (settled) => {
            if (operation.component === "graphql") seen.push(settled);
          },
        }),
      ],
      exports: [HttpRuntime, HttpHandler],
    });
  const query = async (port: number | undefined, source: string) =>
    (
      await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: source }),
      })
    ).json();

  it("answers a refusal on its own alias, beside a sibling that resolved", async ({ boot }) => {
    // GIVEN two aliased fields, one refused by its service
    const info = (await boot(appWith([])).runtimeInfo()).get();

    // WHEN both are asked for in one operation
    const body = await query(info?.port, '{ mine: order(id: "1") theirs: order(id: "refused") }');

    // THEN the sibling is data and the refusal is that alias's error
    expect(body).toEqual({
      data: { mine: "order 1", theirs: null },
      errors: [expect.objectContaining({ path: ["theirs"], extensions: { code: "FORBIDDEN" } })],
    });
  });

  it("answers a refusal at its list index", async ({ boot }) => {
    // GIVEN a list whose second item is refused
    const info = (await boot(appWith([])).runtimeInfo()).get();

    // WHEN the list is asked for
    const body = await query(info?.port, '{ orders(ids: ["1", "refused", "3"]) }');

    // THEN only that item is null, and the error names its index
    expect(body).toEqual({
      data: { orders: ["order 1", null, "order 3"] },
      errors: [expect.objectContaining({ path: ["orders", 1], extensions: { code: "FORBIDDEN" } })],
    });
  });

  it("masks a defect for the client", async ({ boot }) => {
    // GIVEN a field whose service defects
    const info = (await boot(appWith([])).runtimeInfo()).get();

    // WHEN it is asked for
    const body = await query(info?.port, '{ order(id: "broken") }');

    // THEN the client sees Yoga's masked message, never the cause
    expect(body).toEqual({
      data: { order: null },
      errors: [
        expect.objectContaining({
          message: "Unexpected error.",
          path: ["order"],
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        }),
      ],
    });
  });

  it("reports the masked defect to Observers, once", async ({ boot }) => {
    // GIVEN an observer beside a field whose service defects
    const seen: Settled[] = [];
    const info = (await boot(appWith(seen)).runtimeInfo()).get();

    // WHEN it is asked for
    await query(info?.port, '{ order(id: "broken") }');

    // THEN the observer received the defect with its cause
    expect(seen).toEqual([
      {
        outcome: "error",
        cause: expect.objectContaining({
          cause: expect.objectContaining({ message: "database password in this message" }),
        }),
      },
    ]);
  });

  it("reports a defect outside any field, with no path", async ({ boot }) => {
    // GIVEN a plugin that defects before any field resolves
    const seen: Settled[] = [];
    const failing: Plugin = {
      onExecute: () => {
        // oxlint-disable-next-line unthrown/no-throw -- the defect under test
        throw new Error("plugin broke");
      },
    };
    const info = (await boot(appWith(seen, [failing])).runtimeInfo()).get();

    // WHEN any operation runs
    await query(info?.port, '{ order(id: "1") }');

    // THEN the observer received it, with no field to name
    expect(seen).toEqual([
      { outcome: "error", cause: expect.objectContaining({ message: "plugin broke" }) },
    ]);
  });

  it("answers a refusal that carries a cause as the refusal", async ({ boot }) => {
    // GIVEN a refusal minted with the service's own error attached
    const info = (await boot(appWith([])).runtimeInfo()).get();

    // WHEN it is asked for
    const body = await query(info?.port, '{ order(id: "caused") }');

    // THEN the client sees the refusal, not a masked defect
    expect(body).toEqual({
      data: { order: null },
      errors: [
        expect.objectContaining({
          message: "not yours either",
          path: ["order"],
          extensions: { code: "FORBIDDEN" },
        }),
      ],
    });
  });

  it("masks a defect whose cause is a GraphQLError", async ({ boot }) => {
    // GIVEN a service that defects with something shaped like a refusal
    const info = (await boot(appWith([])).runtimeInfo()).get();

    // WHEN it is asked for
    const body = await query(info?.port, '{ order(id: "leaky") }');

    // THEN the client sees the masked message, never the cause
    expect(body).toEqual({
      data: { order: null },
      errors: [
        expect.objectContaining({
          message: "Unexpected error.",
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        }),
      ],
    });
  });

  it("answers a subscription over SSE, each event carrying its own field's error", async ({
    boot,
  }) => {
    // GIVEN a subscription whose second event is refused
    const info = (await boot(appWith([])).runtimeInfo()).get();

    // WHEN a client subscribes over SSE
    const stream = await fetch(`http://127.0.0.1:${info?.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ query: "subscription { placed }" }),
    });
    const events = (await stream.text())
      .split("\n\n")
      .filter((event) => event.startsWith("event: next"))
      .map((event) => JSON.parse(event.slice(event.indexOf("data: ") + 6)));

    // THEN the first event is data and the second carries its refusal
    expect(events).toEqual([
      { data: { placed: "order 1" } },
      {
        data: { placed: null },
        errors: [expect.objectContaining({ path: ["placed"], extensions: { code: "FORBIDDEN" } })],
      },
    ]);
  });

  it("runs context-typed plugin hooks only once the caller is authenticated", async ({ boot }) => {
    // GIVEN a protected mount whose plugin records the principal every
    // context-typed hook sees
    const user = HttpAuthenticator<{ userId: string }>()({
      inject: {},
      sync: () => (headers) =>
        headers.authorization === "Bearer good"
          ? OkAsync({ userId: "u-1" })
          : ErrAsync(new Unauthenticated()),
    });
    const api = defineAuth({ authenticators: { user } });
    const seen: string[] = [];
    const answerer = graphql(api, {
      schema: createSchema({
        typeDefs: "type Query { hello: String }",
        resolvers: { Query: { hello: () => "world" } },
      }),
      requires: [{ user: [] }],
      plugins: [
        {
          onParse: ({ context }) => void seen.push(`parse:${context.principal.userId}`),
          onValidate: ({ context }) => void seen.push(`validate:${context.principal.userId}`),
          onContextBuilding: ({ context }) => void seen.push(`context:${context.principal.userId}`),
          onExecute: ({ args }) => void seen.push(`execute:${args.contextValue.principal.userId}`),
        },
      ],
    });
    const info = (
      await boot(
        Module("PluginAuthGraphqlApp")({
          imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
          provides: [answerer, ...answerer.authenticators],
          exports: [HttpRuntime, HttpHandler],
        }),
        { env: { HTTP_CORS_ORIGIN: "https://web.example" } },
      ).runtimeInfo()
    ).get();
    const url = `http://127.0.0.1:${info?.port}/graphql`;
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ query: "{ hello }" }),
      });

    // WHEN a browser preflights, an anonymous caller is refused, and an
    // authenticated one is answered
    await fetch(url, {
      method: "OPTIONS",
      headers: { origin: "https://web.example", "access-control-request-method": "POST" },
    });
    await post({});
    await post({ authorization: "Bearer good" });

    // THEN only the authenticated request reached the hooks, each with its principal
    expect(seen).toEqual(["parse:u-1", "validate:u-1", "context:u-1", "execute:u-1"]);
  });
});
