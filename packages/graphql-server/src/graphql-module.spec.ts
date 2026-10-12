import { Module, Port, Provider } from "@btravstack/di";
import { HttpAuthenticator, defineAuth } from "@btravstack/http-server";
import { it } from "@btravstack/internal-http-fixtures";
import { createSchema } from "graphql-yoga";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { GraphqlModule } from "./graphql-module.js";
import { graphql } from "./graphql.js";

describe("GraphQL application module", () => {
  it("boots a public mount without runtime or authenticator exports", async ({ boot }) => {
    // GIVEN
    const schema = createSchema({
      typeDefs: "type Query { hello: String! }",
      resolvers: { Query: { hello: () => "world" } },
    });
    const app = boot(
      GraphqlModule("PublicGraphql")({
        port: 0,
        hostname: "127.0.0.1",
        answerer: graphql(defineAuth(), { schema, prefix: "/graph" }),
      }),
    );
    const info = (await app.runtimeInfo()).get();

    // WHEN
    const response = await fetch(`http://127.0.0.1:${info?.port}/graph`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ hello }" }),
    });

    // THEN
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { data: { hello: "world" } },
    });
  });

  it("provides the answerer's authenticators", async ({ boot }) => {
    // GIVEN
    const user = HttpAuthenticator<{ id: string }>()({
      inject: {},
      sync: () => () => OkAsync({ id: "user-1" }),
    });
    const api = defineAuth({ authenticators: { user } });
    const schema = createSchema({
      typeDefs: "type Query { who: String! }",
      resolvers: {
        Query: {
          who: (_parent, _args, context: { principal: { id: string } }) => context.principal.id,
        },
      },
    });
    const app = boot(
      GraphqlModule("ProtectedGraphql")({
        port: 0,
        hostname: "127.0.0.1",
        answerer: graphql(api, { schema, requires: [{ user: [] }] }),
      }),
    );
    const info = (await app.runtimeInfo()).get();

    // WHEN
    const response = await fetch(`http://127.0.0.1:${info?.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ who }" }),
    });

    // THEN
    expect(await response.json()).toEqual({ data: { who: "user-1" } });
  });

  it("binds the answerer's request modules to the runtime", async ({ boot }) => {
    // GIVEN
    const Message = Port("GraphqlModuleMessage")<string>;
    const unit = Module("GraphqlModuleUnit")({
      provides: [Provider(Message)({ inject: {}, value: "scoped" })],
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
    const app = boot(
      GraphqlModule("ScopedGraphql")({
        port: 0,
        hostname: "127.0.0.1",
        answerer: graphql(defineAuth(), {
          schema,
          units: { anonymous: unit },
          unit: { message: Message },
        }),
        provides: [],
        exports: [],
        needs: [],
      }),
    );
    const info = (await app.runtimeInfo()).get();

    // WHEN
    const response = await fetch(`http://127.0.0.1:${info?.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ message }" }),
    });

    // THEN
    expect(await response.json()).toEqual({ data: { message: "scoped:false" } });
  });
});
