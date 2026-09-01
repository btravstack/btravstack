import { describe, expect } from "vitest";

import { it, serviceOf } from "./__tests__/test-fixtures.js";
import { apiKeyAuthenticator } from "./api-key.js";

const authenticator = apiKeyAuthenticator<{ readonly appId: string }, "reports:read">({
  keys: [
    { key: "first-secret", principal: { appId: "reporting" }, scopes: ["reports:read"] },
    { key: "second-secret", principal: { appId: "billing" }, scopes: [] },
  ],
});

const bare = apiKeyAuthenticator<{ readonly appId: string }>({
  header: "x-service-key",
  keys: [{ key: "plain-secret", principal: { appId: "plain" } }],
});

describe("apiKeyAuthenticator", () => {
  it("names the caller the key was issued to, with what it grants", async () => {
    // GIVEN two issued keys
    // WHEN the second is presented
    const resolved = await serviceOf(authenticator)({ "x-api-key": "second-secret" });

    // THEN it is that key's caller, and its own scopes — not the first key's,
    // which is what a loop returning the last match would have answered
    expect(resolved).toBeOkWith(
      expect.objectContaining({ identity: { appId: "billing" }, scopes: [] }),
    );
  });

  it("answers the identity bare when the scheme declares no scopes", async () => {
    // GIVEN a scheme with no scope vocabulary, on a header of its own
    // WHEN its key is presented
    const resolved = await serviceOf(bare)({ "x-service-key": "plain-secret" });

    // THEN the identity arrives unwrapped — byte-for-byte what an unscoped
    // scheme has always returned, so nothing downstream has to narrow
    expect(resolved).toBeOkWith({ appId: "plain" });
  });

  it("refuses a key nobody issued", async () => {
    // GIVEN the same two issued keys
    // WHEN a key that is not one of them is presented
    const resolved = await serviceOf(authenticator)({ "x-api-key": "guessed" });

    // THEN it is refused, carrying no reason: the starter answers 401 and
    // oRPC's default message, so a payload here would be write-only
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses a request presenting no key at all, down the same path", async () => {
    // GIVEN a request with the header absent
    // WHEN it is resolved
    const resolved = await serviceOf(authenticator)({});

    // THEN it takes the same path as a wrong key — the digest of `""` is still
    // compared against every issued key, so "no credential" and "bad
    // credential" are not distinguishable by timing either
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses an empty header value", async () => {
    // GIVEN a header present but empty — what a proxy stripping a credential
    // leaves behind
    // WHEN it is resolved
    const resolved = await serviceOf(authenticator)({ "x-api-key": "" });

    // THEN it is refused rather than matched against a key configured as ""
    expect(resolved).toBeErrTagged("Unauthenticated");
  });
});
