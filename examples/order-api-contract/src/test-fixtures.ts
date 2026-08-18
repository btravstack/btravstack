import { createORPCClient } from "@orpc/client";
import { RPCLink, type RPCLinkOptions } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { createResultClient, type ResultClient } from "@unthrown/orpc/client";
import { test, type TestAPI } from "vitest";

import type { contract, OrderView } from "./contract.js";

/**
 * The caller's view of the API, derived from the **contract** —
 * `RouterContractClient<typeof contract>`, never the server's router.
 * `order-api` ships the same type as `OrderApiClient`; it is restated here
 * rather than imported because this package must not reach `order-api`
 * (see `layering.test-d.ts`), and it types the same two calls, the same
 * inputs and the same declared error codes.
 */
type OrderApiClient = ResultClient<RouterContractClient<typeof contract>>;

type StubFetch = NonNullable<RPCLinkOptions<object>["fetch"]>;

const inputOf = <T>(init: RequestInit): T =>
  (JSON.parse(String(init.body)) as { readonly json: T }).json;

const rpc = (status: number, json: unknown): Response =>
  new Response(JSON.stringify({ json, meta: [] }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * An error the way the wire carries a **declared** one. `inferable` is the flag
 * oRPC sets when an error matches the procedure's `.errors({...})` map, and it
 * is what decides whether the client hands it back as a value or collapses it
 * into a defect. Answering the protocol rather than poking the field is the
 * point: the client under test deserializes this exactly as it would a real
 * server's response.
 */
const declared = (status: number, code: string, id: string): Response =>
  rpc(status, { defined: true, inferable: true, code, message: code, data: { id } });

/**
 * A server substitute that is not a server: a `fetch` over a `Map`, answering
 * the two procedures the contract declares. It stands in for the half of
 * contract-first design this package exists to make possible — the client half,
 * which must work with nothing from the implementation side but these shapes.
 */
const stubServer = (): StubFetch => {
  const stored = new Map<string, OrderView>();

  return async (_url, init, _options, path) => {
    // Keyed by tenant AND id, the way the real schema is: a stub that ignored
    // the tenant would let a contract test pass against an API that leaks
    // between them. `tenantId` is an INPUT here and never an output — the
    // views the contract declares carry no tenant, because a caller that
    // named one does not need telling.
    if (path.join(".") === "orders.place") {
      const { tenantId, id, quantity } = inputOf<{
        readonly tenantId: string;
        readonly id: string;
        readonly quantity: number;
      }>(init);
      if (stored.has(`${tenantId}/${id}`)) return declared(409, "CONFLICT", id);
      stored.set(`${tenantId}/${id}`, { id, quantity });
      return rpc(200, { id, quantity });
    }

    const { tenantId, id } = inputOf<{ readonly tenantId: string; readonly id: string }>(init);
    const found = stored.get(`${tenantId}/${id}`);
    return found === undefined ? declared(404, "NOT_FOUND", id) : rpc(200, found);
  };
};

export type ContractFixtures = {
  /**
   * A client built from the contract alone — `@orpc/contract` for the types,
   * `@orpc/client` for the transport, and nothing from `order-api`.
   */
  readonly client: OrderApiClient;
};

export const it: TestAPI<ContractFixtures> = test.extend<ContractFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  client: async ({}, use) => {
    await use(
      createResultClient(
        createORPCClient<RouterContractClient<typeof contract>>(
          new RPCLink({ origin: "http://stub", url: "/rpc", fetch: stubServer() }),
        ),
      ),
    );
  },
});
