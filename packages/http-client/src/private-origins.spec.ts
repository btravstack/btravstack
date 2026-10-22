import { describe, expect, it } from "vitest";

import { createHttpClient } from "./index.js";

describe("private origin policy", () => {
  it.each(
    [
      null,
      [null],
      [42],
      [{ origin: Symbol("secret"), cidrs: ["10.0.0.0/8"] }],
      [{ origin: "invalid secret", cidrs: ["10.0.0.0/8"] }],
      [{ origin: "https://other.example", cidrs: ["10.0.0.0/8"] }],
      [{ origin: "https://api.example/path", cidrs: ["10.0.0.0/8"] }],
      [{ origin: "https://api.example", cidrs: [] }],
      [{ origin: "https://api.example", cidrs: "10.0.0.0/8" }],
      ...[
        "0.0.0.0/0",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "10.0.0.0/7",
        "172.15.0.0/16",
        "172.16.0.0/11",
        "192.168.0.0/15",
        "8.8.8.8/32",
        "fc00::/6",
        "fc::/16",
        "fe80::/10",
        "::ffff:10.0.0.0/104",
        "invalid/8",
        "10.0.0.0",
        "10.0.0.0/-1",
        "10.0.0.0/08",
        "10.0.0.0/33",
        "fd00::/129",
        "10.0.0.0/8/1",
        42,
      ].map((cidr) => [{ origin: "https://api.example", cidrs: [cidr] }]),
      [
        { origin: "https://api.example", cidrs: ["10.0.0.0/8"] },
        { origin: "https://api.example:443", cidrs: ["10.0.0.0/8"] },
      ],
    ].map((privateOrigins) => ({ privateOrigins })),
  )("refuses malformed or non-private approvals %j", ({ privateOrigins }) => {
    // GIVEN
    // WHEN
    const result = createHttpClient({
      origins: ["https://api.example"],
      privateOrigins: privateOrigins as NonNullable<
        import("./index.js").HttpPolicy["privateOrigins"]
      >,
      maxResponseBytes: 100,
      deadlineMs: 1000,
    });
    // THEN
    expect(result).toBeErrWith(
      expect.objectContaining({ _tag: "HttpPolicyInvalid", field: "privateOrigins" }),
    );
  });

  it.each(["10.96.0.1/32", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8", "fc00::/7"])(
    "accepts private subnet %s",
    (cidr) => {
      // GIVEN
      // WHEN
      const result = createHttpClient({
        origins: ["https://api.example"],
        privateOrigins: [{ origin: "https://API.EXAMPLE:443", cidrs: [cidr] }],
        maxResponseBytes: 100,
        deadlineMs: 1000,
      });
      // THEN
      expect(result).toBeOk();
    },
  );

  it("accepts an approved private literal origin", () => {
    // GIVEN
    const origin = "https://10.96.0.1";
    // WHEN
    const result = createHttpClient({
      origins: [origin],
      privateOrigins: [{ origin, cidrs: ["10.96.0.0/16"] }],
      maxResponseBytes: 100,
      deadlineMs: 1000,
    });
    // THEN
    expect(result).toBeOk();
  });

  it("refuses a private literal outside its own approval", () => {
    // GIVEN
    const origin = "https://10.97.0.1";
    // WHEN
    const result = createHttpClient({
      origins: [origin],
      privateOrigins: [{ origin, cidrs: ["10.96.0.0/16"] }],
      maxResponseBytes: 100,
      deadlineMs: 1000,
    });
    // THEN
    expect(result).toBeErrTagged("HttpPolicyInvalid");
  });
});
