import type { contract } from "@btravstack/example-order-api-contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { createResultClient, type ResultClient } from "@unthrown/orpc/client";

/** What the wire speaks, typed from the contract alone — the router is the server's business. */
type Wire = RouterContractClient<typeof contract>;

/**
 * The caller's view of the API: every procedure returns an `AsyncResult` whose
 * error channel is the inferable `ORPCError` union the contract declares,
 * discriminated by `code`. Everything else — a network failure, a defect
 * collapsed to `INTERNAL_SERVER_ERROR` — is a `Defect`, so the two channels
 * survive the wire in both directions.
 */
export type OrderApiClient = ResultClient<Wire>;

export const createOrderApiClient = (
  origin: string,
  prefix: `/${string}` = "/rpc",
): OrderApiClient =>
  createResultClient(createORPCClient<Wire>(new RPCLink({ origin, url: prefix })));
