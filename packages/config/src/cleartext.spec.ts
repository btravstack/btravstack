import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { cleartext, cleartextRefused } from "./cleartext.js";
import { ConfigInvalid } from "./config.js";

describe("cleartext", () => {
  it.each([
    ["an https: URL", "https://issuer.example/", false, false],
    ["an http: URL on localhost", "http://localhost:4444/", false, true],
    ["an http: URL on 127.0.0.1", "http://127.0.0.1:4444/", false, true],
    ["an http: URL on [::1]", "http://[::1]:4444/", false, true],
    ["an http: URL elsewhere, opted in", "http://issuer.internal/", true, true],
    ["an http: URL elsewhere", "http://issuer.internal/", false, "refused"],
  ] as const)("answers %s", (_name, url, allowed, expected) => {
    // GIVEN a configured URL and whether the caller pinned the opt-in
    // WHEN the rule is asked about it
    const answer = cleartext(url, allowed);

    // THEN it is fine, permitted in cleartext, or refused
    expect(answer).toBe(expected);
  });

  it("refuses as one ConfigInvalid naming the variable and the option", () => {
    // GIVEN the refusal a starter reports
    const args = {
      port: "OAuthClient",
      variable: "OAUTH_ISSUER",
      option: "allowInsecureIssuer",
      on: "oauthClient()",
      what: "it sends the client secret in the open",
    };

    // WHEN it is built
    const refused = cleartextRefused(args);

    // THEN the message names the opt-in at its call, and the issue the variable
    expect(refused).toEqual(
      expect.objectContaining({
        constructor: ConfigInvalid,
        port: "OAuthClient",
        issues: [
          {
            message:
              "must be an https: URL — in cleartext it sends the client secret in the open. Only a loopback host (localhost, 127.0.0.1, [::1]) is accepted without `allowInsecureIssuer: true` on `oauthClient()`",
            path: ["OAUTH_ISSUER"],
          },
        ],
      }),
    );
  });
});
