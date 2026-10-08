import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import { graphql } from "@btravstack/graphql-server";
import { HttpHandler, HttpRuntime, defineAuth, httpServer } from "@btravstack/http-server";

import { orderGraphqlSchema } from "./graphql-schema.js";

export class OrderApiOrigin extends Port("OrderApiOrigin")<{ readonly url: string }> {}
class GraphqlOrigin extends Port("GraphqlOrigin")<{ readonly url: string }> {}

const GraphqlRequest = Module("GraphqlRequest")({
  needs: [OrderApiOrigin],
  provides: [
    Provider(GraphqlOrigin)({
      inject: { origin: OrderApiOrigin },
      sync: ({ origin }) => origin,
    }),
  ],
  exports: [GraphqlOrigin],
});
const graphqlUnits = { anonymous: GraphqlRequest };

/** A separate GraphQL process that forwards operations to the oRPC order API. */
export const OrderGraphqlApi = Module("OrderGraphqlApi")({
  needs: [Env],
  imports: [httpServer({ unit: graphqlUnits })],
  provides: [
    Config.provider(OrderApiOrigin)(
      Config.object({ url: Config.url("ORDER_API_URL", { default: "http://127.0.0.1:3000" }) }),
    ),
    graphql(defineAuth(), {
      schema: orderGraphqlSchema,
      units: graphqlUnits,
      unit: { origin: GraphqlOrigin },
    }),
  ],
  exports: [HttpRuntime, HttpHandler, OrderApiOrigin],
});
