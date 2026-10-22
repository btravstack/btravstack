import { describe, expect } from "vitest";

import { it, mtlsIt } from "./__tests__/test-fixtures.js";
import { createHttpClient, type HttpPolicy } from "./index.js";

describe("private network connections", () => {
  it.for(["10.96.0.1", "fd00:1234::1"])(
    "connects to approved address %s with verified TLS",
    async (address, { network }) => {
      // GIVEN
      network.addresses = [address];
      const client = createHttpClient({
        origins: [network.origin],
        privateOrigins: [{ origin: network.origin, cidrs: ["10.96.0.0/16", "fd00:1234::/32"] }],
        maxResponseBytes: 1024,
        deadlineMs: 30_000,
      }).getOrThrow();
      // WHEN
      const result = await client.request({ url: network.origin });
      // THEN
      expect(
        result.map((response) => ({
          status: response.status,
          body: Buffer.from(response.body).toString(),
        })),
      ).toBeOkWith({ status: 200, body: "hello" });
    },
  );

  it.for([
    { addresses: ["10.96.0.1", "10.97.0.1"] },
    { addresses: ["::ffff:10.96.0.1"] },
    { addresses: ["10.96.0.1", "169.254.169.254"] },
    { addresses: ["fd00:1234::1", "fd00:5678::1"] },
  ])("refuses mixed DNS answers %j", async ({ addresses }, { network }) => {
    // GIVEN
    network.addresses = addresses;
    const client = createHttpClient({
      origins: [network.origin],
      privateOrigins: [{ origin: network.origin, cidrs: ["10.96.0.0/16", "fd00:1234::/32"] }],
      maxResponseBytes: 1024,
      deadlineMs: 30_000,
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpDestinationForbidden");
  });

  it("does not extend another approved origin", async ({ network }) => {
    // GIVEN
    network.addresses = ["10.96.0.1"];
    const client = createHttpClient({
      origins: [network.origin, "https://other.example"],
      privateOrigins: [{ origin: network.origin, cidrs: ["10.96.0.0/16"] }],
      maxResponseBytes: 1024,
      deadlineMs: 30_000,
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: "https://other.example" });
    // THEN
    expect(result).toBeErrTagged("HttpDestinationForbidden");
  });

  it("snapshots approvals before later policy changes", async ({ network }) => {
    // GIVEN
    network.addresses = ["10.97.0.1"];
    const cidrs = ["10.96.0.0/16"];
    const privateOrigins = [{ origin: network.origin, cidrs }];
    const policy: HttpPolicy = {
      origins: [network.origin],
      privateOrigins,
      maxResponseBytes: 1024,
      deadlineMs: 30_000,
    };
    const client = createHttpClient(policy).getOrThrow();
    cidrs.push("10.97.0.0/16");
    privateOrigins.push({ origin: network.origin, cidrs: ["10.0.0.0/8"] });
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpDestinationForbidden");
  });

  it("checks DNS again on a subsequent connection", async ({ network }) => {
    // GIVEN
    network.addresses = ["10.96.0.1"];
    network.rebound = true;
    const client = createHttpClient({
      origins: [network.origin],
      privateOrigins: [{ origin: network.origin, cidrs: ["10.96.0.0/16"] }],
      maxResponseBytes: 1024,
      deadlineMs: 30_000,
    }).getOrThrow();
    // WHEN
    const results = await Promise.all([
      client.request({ url: network.origin }),
      client.request({ url: network.origin }),
    ]);
    // THEN
    expect(
      results.map((result) =>
        result.isOk() ? result.value.status : result.isErr() ? result.error._tag : "defect",
      ),
    ).toEqual([200, "HttpDestinationForbidden"]);
  });

  it("refuses redirects from a private destination", async ({ network }) => {
    // GIVEN
    network.addresses = ["10.96.0.1"];
    network.respond = (_request, response) => {
      response.writeHead(302, { location: "https://169.254.169.254/secret" });
      response.end();
    };
    const client = createHttpClient({
      origins: [network.origin],
      privateOrigins: [{ origin: network.origin, cidrs: ["10.96.0.0/16"] }],
      maxResponseBytes: 1024,
      deadlineMs: 30_000,
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpRedirectRefused");
  });

  it("retains certificate verification on private destinations", async ({ network }) => {
    // GIVEN
    network.addresses = ["10.96.0.1"];
    network.trusted = false;
    const client = createHttpClient({
      origins: [network.origin],
      privateOrigins: [{ origin: network.origin, cidrs: ["10.96.0.0/16"] }],
      maxResponseBytes: 1024,
      deadlineMs: 30_000,
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpUnavailable");
  });

  mtlsIt("uses the configured identity on a private connection", async ({ network }) => {
    // GIVEN
    network.addresses = ["10.96.0.1"];
    const client = createHttpClient({
      origins: [network.origin],
      privateOrigins: [{ origin: network.origin, cidrs: ["10.96.0.0/16"] }],
      tlsIdentities: [{ origin: network.origin, credentials: () => network.identity }],
      maxResponseBytes: 1024,
      deadlineMs: 30_000,
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect(result.map((response) => response.status)).toBeOkWith(200);
  });
});
