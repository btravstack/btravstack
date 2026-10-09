import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { OrderView } from "@btravstack/example-order-api-contract";
import { bootFixture, type Boot } from "@btravstack/testing";
import { test } from "vitest";

import { OrderGraphqlApi } from "./module.js";

/** The order whose `find` the stub answers with a defect. */
const BROKEN = "0199a1e0-0000-7000-8000-0000000000ff";

/** Orders a spec names: one it seeds, one nobody placed, one the API lacks, one it breaks on. */
type Known = {
  readonly placed: OrderView;
  readonly fresh: string;
  readonly missing: string;
  readonly broken: string;
};

type OrderApiStub = {
  /** Every call, in order, as `procedure:id`. */
  readonly calls: readonly string[];
  readonly seed: (order: OrderView) => void;
  readonly url: string;
};

type Gateway = (
  query: string,
  credentials?: "bearer" | "none",
  operationName?: string,
) => Promise<{ readonly data?: unknown; readonly errors?: readonly unknown[] }>;

const bodyOf = async (request: IncomingMessage): Promise<{ readonly json: unknown }> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { readonly json: unknown };
};

const answer = (response: ServerResponse, status: number, json: unknown): void => {
  // The gateway's own calls share the process's connection pool, and the next
  // test's stub may bind this one's port.
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ json, meta: [] }));
};

const declared = (response: ServerResponse, status: number, code: string, id: string): void =>
  answer(response, status, { defined: true, inferable: true, code, message: code, data: { id } });

/**
 * The order API as its client sees it: oRPC's RPC wire format over a `Map`,
 * counting every call. Undeclared refusals and defects are answered the way the
 * real API answers them, so the client classifies them exactly as it would.
 */
const orderApiStub = async (): Promise<OrderApiStub & { readonly close: () => Promise<void> }> => {
  const stored = new Map<string, OrderView>();
  const calls: string[] = [];
  const server = createServer((request, response) => {
    void bodyOf(request).then(({ json }) => {
      const input = json as { readonly id: string; readonly quantity?: number };
      const procedure = request.url?.replace("/rpc/orders/", "") ?? "";
      calls.push(`${procedure}:${input.id}`);
      if (request.headers.authorization !== "Bearer caller")
        return answer(response, 401, {
          defined: false,
          inferable: false,
          code: "UNAUTHORIZED",
          message: "Unauthorized",
        });
      if (procedure === "find") {
        if (input.id === BROKEN)
          return answer(response, 500, {
            defined: false,
            inferable: false,
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal server error",
          });
        const order = stored.get(input.id);
        return order === undefined
          ? declared(response, 404, "NOT_FOUND", input.id)
          : answer(response, 200, order);
      }
      if (stored.has(input.id)) return declared(response, 409, "CONFLICT", input.id);
      const order = { id: input.id, quantity: input.quantity ?? 0 } as OrderView;
      stored.set(order.id, order);
      return answer(response, 200, order);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    calls,
    seed: (order) => void stored.set(order.id, order),
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

export const it = test.extend<{
  boot: Boot;
  known: Known;
  orderApi: OrderApiStub;
  gateway: Gateway;
}>({
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  known: async ({}, use) => {
    await use({
      placed: { id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 } as OrderView,
      fresh: "0199a1e0-0000-7000-8000-000000000002",
      missing: "0199a1e0-0000-7000-8000-000000000404",
      broken: BROKEN,
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  orderApi: async ({}, use) => {
    const stub = await orderApiStub();
    await use(stub);
    await stub.close();
  },

  gateway: async ({ boot, orderApi }, use) => {
    const app = boot(OrderGraphqlApi, { env: { ORDER_API_URL: orderApi.url } });
    const info = (await app.runtimeInfo()).get();
    await use(async (query, credentials = "bearer", operationName) =>
      (
        await fetch(`http://127.0.0.1:${String(info?.port)}/graphql`, {
          method: "POST",
          headers: {
            // A fresh connection per call: a pooled one can outlive the
            // previous test's gateway and be reused on its recycled port.
            connection: "close",
            "content-type": "application/json",
            ...(credentials === "bearer" ? { authorization: "Bearer caller" } : {}),
          },
          body: JSON.stringify({ query, operationName }),
        })
      ).json(),
    );
  },
});
