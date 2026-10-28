import { Config } from "@btravstack/config";
import { TEMPORAL_TLS_FILES } from "@btravstack/internal-test-infra/temporal-tls-files";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { credentialsOf, temporalSecurity } from "./connection-security.js";

describe("the client's connection security", () => {
  it("binds the security from Temporal's own variables", async () => {
    // GIVEN an environment naming the mTLS settings, and leaving the rest unset
    const env = {
      TEMPORAL_TLS: "true",
      TEMPORAL_TLS_SERVER_CA_CERT_PATH: "/run/secrets/ca.pem",
      TEMPORAL_TLS_SERVER_NAME: "temporal.test",
      TEMPORAL_TLS_CLIENT_CERT_PATH: "/run/secrets/tls.crt",
      TEMPORAL_TLS_CLIENT_KEY_PATH: "/run/secrets/tls.key",
    };

    // WHEN the fields are parsed
    const bound = Config.parse("Settings", Config.object(temporalSecurity))(env);

    // THEN each variable lands on its field, and the reload interval takes its default
    await expect(bound).toBeOkWith({
      tls: true,
      serverCaCertPath: "/run/secrets/ca.pem",
      serverName: "temporal.test",
      clientCertPath: "/run/secrets/tls.crt",
      clientKeyPath: "/run/secrets/tls.key",
      apiKey: undefined,
      apiKeyPath: undefined,
      credentialsReloadMs: 60_000,
    });
  });

  it("calls the server over mTLS with the mounted client certificate", async ({
    secured,
    open,
  }) => {
    // GIVEN a connection presenting the mounted certificate to the proxy requiring one
    const connection = (await open(secured.mtls)).getOrThrow();

    // WHEN it describes its namespace
    const described = connection.workflowService.describeNamespace({
      namespace: secured.mtls.namespace,
    });

    // THEN the server answered through the proxy
    await expect(described).resolves.toEqual(
      expect.objectContaining({
        namespaceInfo: expect.objectContaining({ name: secured.mtls.namespace }),
      }),
    );
  });

  it("is refused by a server requiring a client certificate it does not present", async ({
    secured,
    open,
  }) => {
    // GIVEN TLS to the mTLS proxy, without a client certificate
    const { clientCertPath: _cert, clientKeyPath: _key, ...withoutCertificate } = secured.mtls;

    // WHEN the connection is opened
    const opened = await open(withoutCertificate);

    // THEN it is the starter's modeled refusal
    expect(opened).toBeErrTagged(
      "TemporalClientUnreachable",
      expect.objectContaining({ address: secured.mtls.address }),
    );
  });

  it("refuses settings it cannot connect with as ConfigInvalid against the settings port", async ({
    temporal,
    open,
  }) => {
    // GIVEN a server name with TLS off, and a certificate without its key
    const settings = {
      address: temporal.TEMPORAL_ADDRESS,
      namespace: temporal.TEMPORAL_NAMESPACE,
      serverName: "temporal.test",
      clientCertPath: TEMPORAL_TLS_FILES.client.cert,
    };

    // WHEN the connection is opened
    const opened = await open(settings);

    // THEN one ConfigInvalid names every variable to fix
    expect(opened).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({
        port: "SecuredSettings",
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

  it("calls through a new connection once the certificate files are replaced", async ({
    secured,
    open,
  }) => {
    // GIVEN an open connection whose mounted certificate rotates
    const connection = (await open(secured.mtls)).getOrThrow();
    const before = connection.workflowService;
    await secured.install(TEMPORAL_TLS_FILES.rotated);
    await vi.waitUntil(() => connection.workflowService !== before, { timeout: 10_000 });

    // WHEN it describes its namespace
    const described = connection.workflowService.describeNamespace({
      namespace: secured.mtls.namespace,
    });

    // THEN the new connection, opened with the rotated certificate, answered
    await expect(described).resolves.toEqual(
      expect.objectContaining({
        namespaceInfo: expect.objectContaining({ name: secured.mtls.namespace }),
      }),
    );
  });

  it("sends a rotated API key on the open connection", async ({ secured, open }) => {
    // GIVEN an open connection whose mounted API key is replaced by one the server refuses
    const connection = (await open(secured.apiKey)).getOrThrow();
    await secured.writeApiKey("revoked");
    await vi.waitUntil(
      () =>
        connection.workflowService.getSystemInfo({}).then(
          () => false,
          () => true,
        ),
      { timeout: 10_000 },
    );

    // WHEN it calls the server
    const answered = connection.workflowService.getSystemInfo({});

    // THEN the server refused the rotated key, so the connection sent it
    await expect(answered).rejects.toMatchObject({ code: 7 });
  });

  it("refuses a key without its certificate, and an API key beside a client certificate", async () => {
    // GIVEN a client key with no certificate, and an API key
    const security = { tls: true, clientKeyPath: TEMPORAL_TLS_FILES.client.key, apiKey: "key" };

    // WHEN the credentials are read
    const credentials = credentialsOf("Settings", security);

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
    const credentials = credentialsOf("Settings", security);

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
    const credentials = credentialsOf("Settings", security);

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
      apiKeyPath: secured.apiKey.apiKeyPath,
    };

    // WHEN the credentials are read
    const credentials = credentialsOf("Settings", security);

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
    const credentials = credentialsOf("Settings", security);

    // THEN TLS is on, uncustomised, with no key
    await expect(credentials).toBeOkWith({ tls: {}, apiKey: undefined });
  });
});
