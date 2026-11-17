import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

const SERVING = 1;
const NOT_SERVING = 2;

describe("the client's configuration", () => {
  it("binds the address and namespace from the environment", async ({ fake, open }) => {
    // GIVEN an environment naming the service and its namespace
    const env = { TEMPORAL_ADDRESS: "temporal:7233", TEMPORAL_NAMESPACE: "orders" };

    // WHEN the client opens
    const opened = await open(env);

    // THEN the connection went to that address, and the client to that namespace
    expect(
      opened.map(({ client }) => ({
        connect: fake.lazy.mock.calls,
        namespace: client.raw.options.namespace,
      })),
    ).toBeOkWith({ connect: [[{ address: "temporal:7233" }]], namespace: "orders" });
  });

  it("reads 127.0.0.1:7233 and the default namespace when nothing is set", async ({
    fake,
    open,
  }) => {
    // GIVEN an empty environment
    const env = {};

    // WHEN the client opens
    const opened = await open(env);

    // THEN Temporal's own defaults were used
    expect(
      opened.map(({ client }) => ({
        connect: fake.lazy.mock.calls,
        namespace: client.raw.options.namespace,
      })),
    ).toBeOkWith({ connect: [[{ address: "127.0.0.1:7233" }]], namespace: "default" });
  });

  it("lets the options pin the address and namespace over the environment", async ({
    fake,
    open,
  }) => {
    // GIVEN an environment naming another service
    const env = { TEMPORAL_ADDRESS: "elsewhere:7233", TEMPORAL_NAMESPACE: "elsewhere" };

    // WHEN the client opens with both pinned
    const opened = await open(env, { address: "temporal:7233", namespace: "orders" });

    // THEN the pins won
    expect(
      opened.map(({ client }) => ({
        connect: fake.lazy.mock.calls,
        namespace: client.raw.options.namespace,
      })),
    ).toBeOkWith({ connect: [[{ address: "temporal:7233" }]], namespace: "orders" });
  });

  it("refuses a bad variable as ConfigInvalid against the client port", async ({ fake, open }) => {
    // GIVEN a blank namespace and a reload interval that is not a number
    const env = { TEMPORAL_NAMESPACE: " ", TEMPORAL_CREDENTIALS_RELOAD_MS: "soon" };

    // WHEN the client opens
    const opened = await open(env);

    // THEN both variables are named, and no connection was attempted
    expect({ opened, connected: fake.lazy.mock.calls.length }).toEqual({
      opened: expect.objectContaining({
        tag: "Err",
        error: expect.objectContaining({
          _tag: "ConfigInvalid",
          port: "SecuredClient",
          issues: [
            expect.objectContaining({ path: ["TEMPORAL_NAMESPACE"] }),
            expect.objectContaining({ path: ["TEMPORAL_CREDENTIALS_RELOAD_MS"] }),
          ],
        }),
      }),
      connected: 0,
    });
  });
});

describe("the client's connection", () => {
  it("is the one the typed client calls through, closed once with the scope", async ({
    fake,
    open,
  }) => {
    // GIVEN an open client
    const opened = (await open({})).getOrThrow();

    // WHEN its scope closes
    await opened.close();

    // THEN the client used the fake connection, and closed it once
    expect({ same: opened.connection === fake.connection, closes: fake.closes() }).toEqual({
      same: true,
      closes: 1,
    });
  });

  it("qualifies a failed native connection with the attempted address and cause", async ({
    fake,
    open,
  }) => {
    // GIVEN a Temporal endpoint that refuses the connection
    const cause = new Error("connection refused");
    fake.lazy.mockReturnValue({
      ensureConnected: () => Promise.reject(cause),
      close: () => Promise.resolve(),
    } as never);

    // WHEN the client opens
    const opened = await open({ TEMPORAL_ADDRESS: "unavailable:7233" });

    // THEN the modeled error keeps the endpoint and underlying reason
    expect(opened).toBeErrWith(
      expect.objectContaining({
        _tag: "TemporalClientUnreachable",
        address: "unavailable:7233",
        cause,
      }),
    );
  });

  it("hands the native client the data converter the graph provides", async ({ fake, open }) => {
    // GIVEN a converter whose codec the graph provides
    const codec = {
      encode: (p: never) => Promise.resolve(p),
      decode: (p: never) => Promise.resolve(p),
    };
    void fake;

    // WHEN the client opens with the converter's port
    const opened = await open({}, { converter: { payloadCodecs: [codec] } });

    // THEN the native client encodes through that converter's codecs
    expect(
      opened.map(({ client }) => client.raw.options.loadedDataConverter.payloadCodecs),
    ).toBeOkWith([codec]);
  });
});

describe("the client's health check", () => {
  it("is healthy while the service is serving", async ({ scripted, open }) => {
    // GIVEN a client of a service that is serving
    scripted.answer(SERVING);
    const opened = (await open(scripted.env)).getOrThrow();

    // WHEN the health checks run
    const report = await opened.health();

    // THEN the client's check is named for its port, and healthy
    expect(report).toBeOkWith({
      status: "healthy",
      components: [{ name: "temporal-client:SecuredClient", status: "healthy" }],
    });
  });

  it("is unhealthy while the service says it is not serving", async ({ scripted, open }) => {
    // GIVEN a client of a service that has stopped serving
    const opened = (await open(scripted.env)).getOrThrow();
    scripted.answer(NOT_SERVING);

    // WHEN the health checks run
    const report = await opened.health();

    // THEN the check says so
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [
        {
          name: "temporal-client:SecuredClient",
          status: "unhealthy",
          reason: `the Temporal service at ${scripted.env.TEMPORAL_ADDRESS} is not serving`,
        },
      ],
    });
  });

  it("is unhealthy once the service is unreachable", async ({ scripted, open }) => {
    // GIVEN a client whose service has gone away
    const opened = (await open(scripted.env)).getOrThrow();
    await scripted.stop();

    // WHEN the health checks run
    const report = await opened.health();

    // THEN the check is unhealthy: Temporal's client retries an unavailable
    // service, so the kernel's own timeout may be what answers
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [
        { name: "temporal-client:SecuredClient", status: "unhealthy", reason: expect.any(String) },
      ],
    });
  });

  it("is unhealthy once the connection is closed", async ({ scripted, open }) => {
    // GIVEN a client whose scope has closed its connection
    const opened = (await open(scripted.env)).getOrThrow();
    await opened.close();

    // WHEN the health checks run
    const report = await opened.health();

    // THEN the check reports that the service did not answer
    expect(report).toBeOkWith(expect.objectContaining({ status: "unhealthy" }));
  });

  it("is healthy against the Temporal server", async ({ temporal, open }) => {
    // GIVEN a client of the shared server
    const opened = (await open(temporal)).getOrThrow();

    // WHEN the health checks run
    const report = await opened.health();

    // THEN the server answered that it is serving
    expect(report).toBeOkWith(expect.objectContaining({ status: "healthy" }));
  });
});

describe("the client's credential reloading", () => {
  it("reports a credential file it cannot read to the observers", async ({
    secured,
    open,
    observations,
  }) => {
    // GIVEN a client whose mounted API key is emptied
    (await open(secured.apiKey)).getOrThrow();
    await secured.writeApiKey("");

    // WHEN the next reload has settled
    await vi.waitUntil(() => observations.some(({ settled }) => settled !== undefined), {
      timeout: 10_000,
    });

    // THEN it was reported as a failed reload, naming the file
    expect(observations[0]).toEqual({
      operation: { component: "temporal-client", name: "reload", attributes: {} },
      settled: {
        outcome: "error",
        cause: expect.objectContaining({
          _tag: "ConfigInvalid",
          issues: [{ message: "is empty", path: ["TEMPORAL_API_KEY_PATH"] }],
        }),
      },
    });
  });
});
