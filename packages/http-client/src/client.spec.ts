import { describe, expect, it } from "vitest";

import { createHttpClient } from "./index.js";

describe("application HTTP policy", () => {
  it.each([
    "http://api.example",
    "https://user:secret@api.example",
    "https://api.example/path",
    "invalid",
  ])("rejects invalid approved origin %s", (origin) => {
    // GIVEN
    const policy = { origins: [origin], maxResponseBytes: 1024, deadlineMs: 1000 };
    // WHEN
    const result = createHttpClient(policy);
    // THEN
    expect(result).toBeErrTagged("HttpPolicyInvalid");
  });
});

describe("request approvals", () => {
  it.each([0, -1, NaN, Infinity, 1.2, 2147483648])("refuses invalid limit %s", (limit) => {
    // GIVEN
    // WHEN
    const result = createHttpClient({
      origins: ["https://api.example"],
      maxResponseBytes: limit,
      deadlineMs: 1000,
    });
    // THEN
    expect(result).toBeErrTagged("HttpPolicyInvalid");
  });
  it("requires at least one approved origin", () => {
    // GIVEN
    // WHEN
    const result = createHttpClient({ origins: [], maxResponseBytes: 100, deadlineMs: 1000 });
    // THEN
    expect(result).toBeErrTagged("HttpPolicyInvalid");
  });
  it.each([
    ["http://api.example", "HttpPolicyRejected"],
    ["https://u:p@api.example", "HttpPolicyRejected"],
    ["https://127.0.0.1", "HttpDestinationForbidden"],
    ["https://[::ffff:127.0.0.1]", "HttpDestinationForbidden"],
    ["https://api.example:8443", "HttpPolicyRejected"],
    ["https://evil.example", "HttpPolicyRejected"],
    ["malformed secret", "HttpPolicyRejected"],
  ])("refuses request %s before opening a connection", async (url, tag) => {
    // GIVEN
    const client = createHttpClient({
      origins: ["https://API.EXAMPLE:443"],
      maxResponseBytes: 100,
      deadlineMs: 1000,
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url });
    // THEN
    expect(result).toBeErrTagged(tag);
  });
  it.each([
    { Host: "evil.example" },
    { Trailer: "x-checksum" },
    { "Transfer-Encoding": "chunked" },
    { "bad\nname": "x" },
    { authorization: "secret\r\nHost: evil.example" },
  ])("refuses unsafe headers %j", async (headers) => {
    // GIVEN
    const client = createHttpClient({
      origins: ["https://api.example"],
      maxResponseBytes: 100,
      deadlineMs: 1000,
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: "https://api.example", headers });
    // THEN
    expect(result).toBeErrTagged("HttpPolicyRejected");
  });
});
