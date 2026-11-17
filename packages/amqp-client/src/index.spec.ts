import { ConnectionError } from "@amqp-contract/client";
import { HealthChecks } from "@btravstack/core";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { Client, contract, it } from "./__tests__/test-fixtures.js";

describe("amqpClient", () => {
  describe("configuration", () => {
    it.for([
      {
        name: "the defaults when nothing is set",
        options: {},
        url: "amqp://127.0.0.1:5672",
        timeout: 5_000,
      },
      {
        name: "AMQP_URL and AMQP_CONNECT_TIMEOUT_MS",
        options: { env: { AMQP_URL: "amqp://from-env", AMQP_CONNECT_TIMEOUT_MS: "750" } },
        url: "amqp://from-env",
        timeout: 750,
      },
      {
        name: "the pins over the variables",
        options: {
          url: "amqp://pinned",
          connectTimeoutMs: 1_000,
          env: { AMQP_URL: "amqp://from-env", AMQP_CONNECT_TIMEOUT_MS: "750" },
        },
        url: "amqp://pinned",
        timeout: 1_000,
      },
    ])(
      "opens the client from $name, with half the timeout on the handshake",
      async ({ options, url, timeout }, { upstream, scoped }) => {
        // GIVEN an upstream client with no broker behind it

        // WHEN the scope opens
        await scoped(options, () => OkAsync());

        // THEN the upstream client was asked for that broker and those budgets
        expect(upstream.create.mock.calls[0]?.[0]).toEqual({
          contract,
          urls: [url],
          connectTimeoutMs: timeout,
          logger: expect.objectContaining({ warn: expect.any(Function) }),
          connectionOptions: { connectionOptions: { timeout: Math.ceil(timeout / 2) } },
        });
      },
    );

    it("refuses a variable it cannot read, naming it", async ({ upstream, scoped }) => {
      // GIVEN a timeout that is not a number
      const env = { AMQP_CONNECT_TIMEOUT_MS: "soon" };

      // WHEN the scope opens
      const result = await scoped({ env }, () => OkAsync());

      // THEN start-up fails with the variable named, and no connection was attempted
      expect({
        error: result.isErr() && result.error,
        attempts: upstream.create.mock.calls.length,
      }).toEqual({
        error: expect.objectContaining({
          _tag: "ConfigInvalid",
          port: Client.portId,
          message: expect.stringContaining("AMQP_CONNECT_TIMEOUT_MS"),
        }),
        attempts: 0,
      });
    });
  });

  describe("lifetime", () => {
    it("hands the client to the application and closes it once as the scope ends", async ({
      upstream,
      scoped,
    }) => {
      // GIVEN an upstream client with no broker behind it

      // WHEN the scope opens and closes
      const result = await scoped({}, (ctx) => OkAsync(ctx.get(Client)));

      // THEN the application saw the upstream client, closed exactly once
      expect({ client: result.getOrNull(), closes: upstream.close.mock.calls.length }).toEqual({
        client: upstream.client,
        closes: 1,
      });
    });

    it("keeps the upstream connection error on the startup channel", async ({
      upstream,
      scoped,
    }) => {
      // GIVEN an upstream connection refusal
      const error = new ConnectionError("broker unavailable");
      upstream.create.mockReturnValue(ErrAsync(error));

      // WHEN the scope tries to acquire the client
      const result = await scoped({}, () => OkAsync());

      // THEN the application gets the original modeled error
      expect(result).toBeErrWith(error);
    });

    it("fails start-up within its connect timeout when the broker never answers", async ({
      silentBroker,
      scoped,
    }) => {
      // GIVEN a broker that accepts the connection and never speaks AMQP
      const started = performance.now();

      // WHEN the scope tries to acquire the client with a half-second budget
      const result = await scoped({ url: silentBroker, connectTimeoutMs: 500 }, () => OkAsync());

      // THEN the modeled error names the timed-out handshake, well before a reconnect interval
      expect({
        error: result.isErr() && result.error,
        withinBudget: performance.now() - started < 2_000,
      }).toEqual({
        error: expect.objectContaining({
          _tag: "@amqp-contract/ConnectionError",
          message: expect.stringContaining("connect ETIMEDOUT"),
        }),
        withinBudget: true,
      });
    });
  });

  describe("health", () => {
    it("is healthy while connected and failing once the connection drops", async ({
      upstream,
      scoped,
    }) => {
      // GIVEN the client's health check, read out of a scope over a connected client
      const [health] = (await scoped({}, (ctx) => OkAsync(ctx.get(HealthChecks)))).getOrThrow();
      const connected = await health?.check();

      // WHEN the connection drops
      upstream.connected = false;
      const dropped = await health?.check();

      // THEN the check names the client's port, and fails only once disconnected
      expect({
        name: health?.name,
        connected: connected?.isOk(),
        dropped: dropped?.isErr() && dropped.error,
      }).toEqual({
        name: `amqp-client:${Client.portId}`,
        connected: true,
        dropped: expect.objectContaining({ _tag: "HealthCheckFailed", reason: expect.any(String) }),
      });
    });
  });

  describe("observations", () => {
    it("reports a failed connection attempt to Observers", async ({
      droppingBroker,
      observations,
      scoped,
    }) => {
      // GIVEN a broker that drops every connection

      // WHEN the scope tries to acquire the client
      await scoped({ url: droppingBroker, connectTimeoutMs: 500 }, () => OkAsync());

      // THEN the library's retry warning reached the observer as an error outcome
      expect(observations).toContainEqual({
        operation: {
          component: "amqp-client",
          name: "broker",
          attributes: { level: "warn" },
          details: { message: "AMQP connection attempt failed; retrying" },
          traced: false,
        },
        settled: expect.objectContaining({ outcome: "error", cause: expect.anything() }),
      });
    });
  });
});
