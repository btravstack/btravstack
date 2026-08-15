import type { ServiceOf } from "@btravstack/di";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createResultClient, type ResultClient } from "@unthrown/orpc/client";

import type { OrderRouter } from "./router.js";

/**
 * The caller's view of the API: every procedure returns an `AsyncResult` whose
 * error channel is the inferable `ORPCError` union the contract declares,
 * discriminated by `code`. Everything else — a network failure, a defect
 * collapsed to `INTERNAL_SERVER_ERROR` — is a `Defect`, so the two channels
 * survive the wire in both directions.
 */
export type OrderApiClient = ResultClient<RouterClient<ServiceOf<OrderRouter>>>;

export const createOrderApiClient = (
  origin: string,
  prefix: `/${string}` = "/rpc",
): OrderApiClient =>
  createResultClient(
    createORPCClient<RouterClient<ServiceOf<OrderRouter>>>(new RPCLink({ origin, url: prefix })),
  );
