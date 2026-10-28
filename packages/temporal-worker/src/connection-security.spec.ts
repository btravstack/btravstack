import { TEMPORAL_TLS_FILES } from "@btravstack/internal-test-infra/temporal-tls-files";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { credentialsOf } from "./connection-security.js";

describe("the worker's connection security", () => {
  it("serves a workflow over mTLS with the mounted client certificate", async ({
    secured,
    serveObserved,
  }) => {
    // GIVEN a worker connecting through the proxy that requires a client certificate
    const { client, taskQueue } = await serveObserved(false, secured.mtls);

    // WHEN a workflow runs on its queue
    const result = client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `wf-mtls-${taskQueue}`,
      args: ["secured"],
    });

    // THEN the worker's activity answered it
    await expect(result).resolves.toBe("secured");
  });

  it("is refused by a server requiring a client certificate it does not present", async ({
    secured,
    serveBroken,
  }) => {
    // GIVEN TLS to the mTLS proxy, without a client certificate
    const {
      TEMPORAL_TLS_CLIENT_CERT_PATH: _cert,
      TEMPORAL_TLS_CLIENT_KEY_PATH: _key,
      ...withoutCertificate
    } = secured.mtls;
    const app = await serveBroken({ env: withoutCertificate });

    // WHEN the application is started
    // THEN the connection is the starter's modeled refusal
    await expect(app.exited).toBeErrTagged(
      "TemporalUnreachable",
      expect.objectContaining({ address: secured.mtls["TEMPORAL_ADDRESS"] }),
    );
  });

  it("refuses at startup every setting it cannot connect with, naming each variable", async ({
    server,
    serveBroken,
  }) => {
    // GIVEN TLS settings with TLS off, and a certificate without its key
    const app = await serveBroken({
      env: {
        TEMPORAL_ADDRESS: server.address,
        TEMPORAL_NAMESPACE: server.namespace,
        TEMPORAL_TLS_SERVER_NAME: "temporal.test",
        TEMPORAL_TLS_CLIENT_CERT_PATH: TEMPORAL_TLS_FILES.client.cert,
      },
    });

    // WHEN the application is started
    // THEN one ConfigInvalid names every variable to fix
    await expect(app.exited).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({
        port: "TemporalConfig",
        issues: [
          { message: "requires TEMPORAL_TLS=true", path: ["TEMPORAL_TLS_SERVER_NAME"] },
          { message: "requires TEMPORAL_TLS=true", path: ["TEMPORAL_TLS_CLIENT_CERT_PATH"] },
          {
            message: "is required with TEMPORAL_TLS_CLIENT_CERT_PATH",
            path: ["TEMPORAL_TLS_CLIENT_KEY_PATH"],
          },
        ],
      }),
    );
  });

  it("moves to a new connection when the certificate files are replaced, and keeps serving", async ({
    secured,
    serveObserved,
  }) => {
    // GIVEN a worker over mTLS, whose mounted certificate rotates twice
    const { client, taskQueue, taken } = await serveObserved(false, secured.mtls);
    const reloads = () => taken().filter(({ name }) => name === "reload");
    await secured.install(TEMPORAL_TLS_FILES.rotated);
    await vi.waitUntil(() => reloads().length === 1, { timeout: 10_000 });
    await secured.install(TEMPORAL_TLS_FILES.client);
    await vi.waitUntil(() => reloads().length === 2, { timeout: 10_000 });

    // WHEN a workflow runs on its queue
    const result = await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `wf-rotated-${taskQueue}`,
      args: ["rotated"],
    });

    // THEN each rotation connected, and the worker served the workflow after both
    expect({ reloads: reloads(), result }).toEqual({
      reloads: [
        { component: "temporal", name: "reload", attributes: {}, outcome: "ok" },
        { component: "temporal", name: "reload", attributes: {}, outcome: "ok" },
      ],
      result: "rotated",
    });
  });

  it("keeps its connection when the replaced certificate is refused, and reports it", async ({
    secured,
    serveObserved,
  }) => {
    // GIVEN a worker over mTLS whose mounted certificate is replaced by one the server distrusts
    const { client, taskQueue, taken } = await serveObserved(false, secured.mtls);
    const reloads = () => taken().filter(({ name }) => name === "reload");
    await secured.install(TEMPORAL_TLS_FILES.untrusted);
    await vi.waitUntil(() => reloads().length > 0, { timeout: 10_000 });

    // WHEN a workflow runs on its queue
    const result = await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `wf-refused-${taskQueue}`,
      args: ["kept"],
    });

    // THEN the refused reload was observed as an error, and the worker still served
    expect({ reload: reloads()[0], result }).toEqual({
      reload: { component: "temporal", name: "reload", attributes: {}, outcome: "error" },
      result: "kept",
    });
  });

  it("sends its API key as a bearer token and sets a rotated key on its connection", async ({
    secured,
    serveObserved,
  }) => {
    // GIVEN a worker authenticating with a mounted API key, which rotates
    const { client, taskQueue, taken } = await serveObserved(false, secured.apiKey);
    const reloads = () => taken().filter(({ name }) => name === "reload");
    await secured.writeApiKey("temporal-test-second");
    await vi.waitUntil(() => reloads().length === 1, { timeout: 10_000 });

    // WHEN a workflow runs on its queue
    const result = await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `wf-api-key-${taskQueue}`,
      args: ["keyed"],
    });

    // THEN the key was set, and the worker served the workflow with it
    expect({ reloads: reloads(), result }).toEqual({
      reloads: [{ component: "temporal", name: "reload", attributes: {}, outcome: "ok" }],
      result: "keyed",
    });
  });

  it("reports a credential file it can no longer read, and keeps its connection", async ({
    secured,
    serveObserved,
  }) => {
    // GIVEN a worker authenticating with a mounted API key, whose file is emptied
    const { client, taskQueue, taken } = await serveObserved(false, secured.apiKey);
    const reloads = () => taken().filter(({ name }) => name === "reload");
    await secured.writeApiKey("");
    await vi.waitUntil(() => reloads().length > 0, { timeout: 10_000 });

    // WHEN a workflow runs on its queue
    const result = await client.workflow.execute("runEcho", {
      taskQueue,
      workflowId: `wf-unreadable-${taskQueue}`,
      args: ["kept"],
    });

    // THEN the unreadable file was observed as an error, and the worker still served
    expect({ reload: reloads()[0], result }).toEqual({
      reload: { component: "temporal", name: "reload", attributes: {}, outcome: "error" },
      result: "kept",
    });
  });

  it("refuses a key without its certificate, and an API key beside a client certificate", async () => {
    // GIVEN a client key with no certificate, and an API key
    const security = { tls: true, clientKeyPath: TEMPORAL_TLS_FILES.client.key, apiKey: "key" };

    // WHEN the credentials are read
    const credentials = credentialsOf("TemporalConfig", security);

    // THEN both refusals name their variable
    await expect(credentials).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({
        issues: [
          {
            message: "is required with TEMPORAL_TLS_CLIENT_KEY_PATH",
            path: ["TEMPORAL_TLS_CLIENT_CERT_PATH"],
          },
          { message: "cannot be combined with a client certificate", path: ["TEMPORAL_API_KEY"] },
        ],
      }),
    );
  });

  it("refuses an API key file beside an API key, and beside a client certificate", async () => {
    // GIVEN an API key file next to an inline key and a client certificate
    const security = {
      tls: true,
      apiKey: "key",
      apiKeyPath: "/run/secrets/api-key",
      clientCertPath: TEMPORAL_TLS_FILES.client.cert,
      clientKeyPath: TEMPORAL_TLS_FILES.client.key,
    };

    // WHEN the credentials are read
    const credentials = credentialsOf("TemporalConfig", security);

    // THEN the file is refused against the key, and the key against the certificate
    await expect(credentials).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({
        issues: [
          { message: "cannot be combined with TEMPORAL_API_KEY", path: ["TEMPORAL_API_KEY_PATH"] },
          { message: "cannot be combined with a client certificate", path: ["TEMPORAL_API_KEY"] },
        ],
      }),
    );
  });

  it("refuses an API key file beside a client certificate", async () => {
    // GIVEN an API key file and a client certificate
    const security = {
      tls: true,
      apiKeyPath: "/run/secrets/api-key",
      clientCertPath: TEMPORAL_TLS_FILES.client.cert,
      clientKeyPath: TEMPORAL_TLS_FILES.client.key,
    };

    // WHEN the credentials are read
    const credentials = credentialsOf("TemporalConfig", security);

    // THEN the file is the variable refused
    await expect(credentials).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({
        issues: [
          {
            message: "cannot be combined with a client certificate",
            path: ["TEMPORAL_API_KEY_PATH"],
          },
        ],
      }),
    );
  });

  it("refuses a file it cannot read, and an empty API key file", async ({ secured }) => {
    // GIVEN a CA path that does not exist, and an API key file holding only a newline
    await secured.writeApiKey("");
    const security = {
      tls: true,
      serverCaCertPath: "/nonexistent/ca.pem",
      apiKeyPath: secured.apiKey["TEMPORAL_API_KEY_PATH"],
    };

    // WHEN the credentials are read
    const credentials = credentialsOf("TemporalConfig", security);

    // THEN each file is named with what is wrong with it
    await expect(credentials).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({
        issues: [
          { message: "cannot be read (ENOENT)", path: ["TEMPORAL_TLS_SERVER_CA_CERT_PATH"] },
          { message: "is empty", path: ["TEMPORAL_API_KEY_PATH"] },
        ],
      }),
    );
  });

  it("connects with TLS and the system's roots when it names nothing else", async () => {
    // GIVEN TLS on, with no CA, server name or credential
    const security = { tls: true };

    // WHEN the credentials are read
    const credentials = credentialsOf("TemporalConfig", security);

    // THEN TLS is on, uncustomised, with no key
    await expect(credentials).toBeOkWith({ tls: {}, apiKey: undefined });
  });
});
