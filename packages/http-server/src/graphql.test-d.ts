import { Module } from "@btravstack/di";
import type { GraphQLSchema } from "graphql";

import { HttpAuthenticator } from "./auth.js";
import { defineHttp } from "./define-http.js";
import { graphql } from "./graphql.js";
import { HttpHandler } from "./handler.js";
import { HttpRuntime, httpServer } from "./http-runtime.js";

const schema = null as unknown as GraphQLSchema;
const user = HttpAuthenticator<{ id: string }, "orders:read">()({
  inject: {},
  sync: () => null as never,
});
const api = defineHttp({ authenticators: { user } });

graphql(api, { schema, requires: [{ user: ["orders:read"] }] });

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
