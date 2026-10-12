import { start } from "@btravstack/core";
import { defineAuth } from "@btravstack/http-server";
import { createSchema } from "graphql-yoga";

import { GraphqlModule } from "./graphql-module.js";
import { graphql } from "./graphql.js";

const schema = createSchema({
  typeDefs: "type Query { hello: String! }",
  resolvers: { Query: { hello: () => "world" } },
});

export const GatewayApi = GraphqlModule("GatewayApi")({
  answerer: graphql(defineAuth(), { schema }),
});
void start(GatewayApi);
