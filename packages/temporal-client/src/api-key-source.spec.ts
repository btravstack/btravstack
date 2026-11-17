import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { credentialsOf } from "./connection-security.js";
import { TemporalApiKeyUnavailable } from "./index.js";

describe("renewable client credentials", () => {
  it("authenticates namespace calls with the application source", async ({
    secured,
    renewable,
    open,
  }) => {
    // GIVEN
    const { TEMPORAL_API_KEY_PATH: _file, ...env } = secured.apiKey;
    const connection = (await open(env, { source: renewable.source })).getOrThrow().connection;

    // WHEN
    const answer = connection.workflowService.describeNamespace({
      namespace: env.TEMPORAL_NAMESPACE,
    });

    // THEN
    await expect(answer).resolves.toMatchObject({
      namespaceInfo: { name: env.TEMPORAL_NAMESPACE },
    });
  });

  it("refuses an unavailable source before opening the connection", async ({
    secured,
    renewable,
    open,
  }) => {
    // GIVEN
    const { TEMPORAL_API_KEY_PATH: _file, ...env } = secured.apiKey;
    renewable.set(undefined);

    // WHEN
    const answer = await open(env, { source: renewable.source });

    // THEN
    expect(answer).toBeErrWith(new TemporalApiKeyUnavailable());
  });

  it("sends a renewed key without replacing the connection", async ({
    secured,
    renewable,
    open,
  }) => {
    // GIVEN
    const { TEMPORAL_API_KEY_PATH: _file, ...env } = secured.apiKey;
    const connection = (await open(env, { source: renewable.source })).getOrThrow().connection;
    const service = connection.workflowService;
    renewable.set("revoked");
    await vi.waitUntil(() =>
      connection.workflowService.describeNamespace({ namespace: env.TEMPORAL_NAMESPACE }).then(
        () => false,
        () => true,
      ),
    );

    // WHEN
    const code = await connection.workflowService
      .describeNamespace({ namespace: env.TEMPORAL_NAMESPACE })
      .then(
        () => undefined,
        (failure: { code: number }) => failure.code,
      );

    // THEN
    expect({ code, sameConnection: connection.workflowService === service }).toEqual({
      code: 7,
      sameConnection: true,
    });
  });

  it("closes on source removal and reconnects after the same credential returns", async ({
    secured,
    renewable,
    open,
  }) => {
    // GIVEN
    const { TEMPORAL_API_KEY_PATH: _file, ...env } = secured.apiKey;
    const connection = (await open(env, { source: renewable.source })).getOrThrow().connection;
    const service = connection.workflowService;
    renewable.set(undefined);
    await vi.waitUntil(() =>
      connection.workflowService.describeNamespace({ namespace: env.TEMPORAL_NAMESPACE }).then(
        () => false,
        () => true,
      ),
    );

    // WHEN
    renewable.set("temporal-test-first");
    await vi.waitUntil(() => connection.workflowService !== service);
    const answer = await connection.workflowService.describeNamespace({
      namespace: env.TEMPORAL_NAMESPACE,
    });

    // THEN
    expect(answer).toMatchObject({ namespaceInfo: { name: env.TEMPORAL_NAMESPACE } });
  });

  it("waits for an in-flight source read and never reopens after close", async ({
    secured,
    heldSource,
    open,
  }) => {
    // GIVEN
    const { TEMPORAL_API_KEY_PATH: _file, ...env } = secured.apiKey;
    const connection = (await open(env, { source: heldSource.source })).getOrThrow().connection;
    const service = connection.workflowService;
    await heldSource.entered;

    // WHEN
    const closing = connection.close();
    heldSource.release();
    await closing;
    const refused = await connection.workflowService
      .describeNamespace({ namespace: env.TEMPORAL_NAMESPACE })
      .then(
        () => false,
        () => true,
      );

    // THEN
    expect({ refused, sameConnection: connection.workflowService === service }).toEqual({
      refused: true,
      sameConnection: true,
    });
  });

  it("turns TLS on for a source without caching its credential", async ({ renewable }) => {
    // GIVEN
    const security = {};

    // WHEN
    const first = await credentialsOf("Settings", security, renewable.source);
    renewable.set("temporal-test-second");
    const second = await credentialsOf("Settings", security, renewable.source);

    // THEN
    expect({ first, second, reads: renewable.reads() }).toEqual({
      first: expect.objectContaining({
        tag: "Ok",
        value: { tls: {}, apiKey: "temporal-test-first" },
      }),
      second: expect.objectContaining({
        tag: "Ok",
        value: { tls: {}, apiKey: "temporal-test-second" },
      }),
      reads: 2,
    });
  });

  it.for([
    { tls: false },
    { apiKey: "private-key" },
    { apiKeyPath: "/private-key" },
    { clientCertPath: "/private-certificate", clientKeyPath: "/private-key" },
  ])(
    "refuses conflicting deployment credentials before asking the source: %j",
    async (security, { renewable }) => {
      // GIVEN
      const source = renewable.source;

      // WHEN
      const answer = await credentialsOf("Settings", security, source);

      // THEN
      expect({ refused: answer.isErr(), reads: renewable.reads() }).toEqual({
        refused: true,
        reads: 0,
      });
    },
  );

  it("refuses an empty source answer without exposing it in diagnostics", async ({ renewable }) => {
    // GIVEN
    renewable.set("  ");

    // WHEN
    const answer = await credentialsOf("Settings", {}, renewable.source);

    // THEN
    expect(answer).toBeErrWith(new TemporalApiKeyUnavailable());
  });
});
