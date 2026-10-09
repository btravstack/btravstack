import { Module, Port, Provider } from "@btravstack/di";
import { HttpAuthenticator } from "@btravstack/http-server";
import { defineAuth } from "@btravstack/http-server";
import { HttpHandler } from "@btravstack/http-server/internal";
import { HttpRuntime, httpServer } from "@btravstack/http-server/internal";
import type { GraphQLSchema } from "graphql";
import type { Plugin } from "graphql-yoga";

import { graphql } from "./graphql.js";

const schema = null as unknown as GraphQLSchema;
const user = HttpAuthenticator<{ id: string }, "orders:read">()({
  inject: {},
  sync: () => null as never,
});
const api = defineAuth({ authenticators: { user } });

graphql(api, { schema, requires: [{ user: ["orders:read"] }] });

class Message extends Port("GraphqlMessage")<string> {}
class Missing extends Port("GraphqlMissing")<string> {}
const userUnit = Module("GraphqlUserUnit")({
  provides: [Provider(Message)({ inject: {}, value: "hello" })],
  exports: [Message],
});
graphql(api, {
  schema,
  requires: [{ user: [] }],
  units: { user: userUnit },
  unit: { message: Message },
});
graphql(api, {
  schema,
  requires: [{ user: [] }],
  units: { user: userUnit },
  // @ts-expect-error -- the selected user unit does not export this port
  unit: { missing: Missing },
});

const protectedAnswerer = graphql(api, { schema, requires: [{ user: [] }] });
// @ts-expect-error -- a protected GraphQL mount owes its scheme's provider
Module("MissingGraphqlAuthenticator")({
  imports: [httpServer({ port: 0 })],
  provides: [protectedAnswerer],
  exports: [HttpRuntime, HttpHandler],
});

Module("ProtectedGraphql")({
  imports: [httpServer({ port: 0 })],
  provides: [protectedAnswerer, ...protectedAnswerer.authenticators],
  exports: [HttpRuntime, HttpHandler],
});

// @ts-expect-error -- a scope outside the authenticator's vocabulary cannot protect a mount
graphql(api, { schema, requires: [{ user: ["orders:write"] }] });

// @ts-expect-error -- one requirement names one scheme; alternatives are separate entries
graphql(api, { schema, requires: [{ user: [], service: [] }] });

// Plugins: one typed by the context it reads is accepted when this call builds
// that context, an inline one is typed by it, and one reading what the call
// never binds is refused.
const readsMessage: Plugin<{ readonly unit: { readonly message: string } }> = {};
const readsMissing: Plugin<{ readonly unit: { readonly missing: string } }> = {};
const plain: Plugin = {};
graphql(api, {
  schema,
  requires: [{ user: [] }],
  units: { user: userUnit },
  unit: { message: Message },
  plugins: [readsMessage, plain],
});
graphql(api, {
  schema,
  requires: [{ user: [] }],
  units: { user: userUnit },
  unit: { message: Message },
  plugins: [
    {
      onExecute: ({ args }) => {
        const { message } = args.contextValue.unit;
        const { id } = args.contextValue.principal;
        void [message, id];
      },
    },
  ],
});
graphql(api, {
  schema,
  requires: [{ user: [] }],
  units: { user: userUnit },
  unit: { message: Message },
  // @ts-expect-error -- PLUGIN CONTEXT MISMATCH: the call binds no `missing` on `unit`
  plugins: [readsMessage, readsMissing],
});
