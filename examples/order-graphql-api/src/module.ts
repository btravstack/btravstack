import { Config, Env } from "@btravstack/config";
import { Module } from "@btravstack/di";
import { graphql } from "@btravstack/graphql-server";
import { HttpHandler, HttpRuntime, defineAuth, httpServer } from "@btravstack/http-server";

import { orderGraphqlSchema } from "./graphql-schema.js";
import { maxAliases } from "./limits.js";
import { OrderApiOrigin, OrderReads, orderReads } from "./order-reads.js";

/** What every request forks: its own order reads, and with them its own cache. */
const GraphqlRequest = Module("GraphqlRequest")({
  needs: [OrderApiOrigin],
  provides: [orderReads],
  exports: [OrderReads],
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
      unit: { reads: OrderReads },
      plugins: [maxAliases(10)],
    }),
  ],
  exports: [HttpRuntime, HttpHandler, OrderApiOrigin],
});
