import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { logoutRedirectUri } from "./oidc-logout-uri.js";

describe("registered logout return configuration", () => {
  it("keeps the return optional for existing deployments", () => {
    // GIVEN
    const field = logoutRedirectUri("HTTP_OIDC_POST_LOGOUT_REDIRECT_URI");
    // WHEN
    const value = field.parse(undefined);
    // THEN
    expect(value).toBeOkWith(undefined);
  });

  it.for(["https://app.example/signed-out?done=true", "http://localhost:3000/signed-out"])(
    "accepts a registered HTTP(S) destination: %s",
    (uri) => {
      // GIVEN
      const field = logoutRedirectUri("HTTP_OIDC_POST_LOGOUT_REDIRECT_URI");
      // WHEN
      const value = field.parse(uri);
      // THEN
      expect(value).toBeOkWith(uri);
    },
  );

  it.for([
    "",
    " ",
    "/signed-out",
    "//other.example",
    "javascript:alert(1)",
    "https://name:private@app.example/",
    "https://app.example/#fragment",
    "https://app.example/#",
    "https://app.example/signed out",
    "https://app.example/\nother",
  ])("refuses an invalid return without echoing it: %j", (uri) => {
    // GIVEN
    const field = logoutRedirectUri("HTTP_OIDC_POST_LOGOUT_REDIRECT_URI");
    // WHEN
    const value = field.parse(uri);
    // THEN
    expect(value).toBeErrWith(
      expect.objectContaining({
        _tag: "ConfigFieldInvalid",
        reason: "must be an absolute HTTP(S) URI without credentials or a fragment",
      }),
    );
  });

  it("refuses a configured return without server-side token retention at boot", async ({
    tokens,
  }) => {
    // GIVEN
    // WHEN
    const built = await tokens.loginProvider(
      { postLogoutRedirectUri: "https://app.example/signed-out" },
      true,
    );
    // THEN
    expect(built).toBeErrWith(
      expect.objectContaining({
        _tag: "ConfigInvalid",
        issues: [
          {
            message: "a post-logout return URI requires a server-side token manager",
            path: ["HTTP_OIDC_POST_LOGOUT_REDIRECT_URI"],
          },
        ],
      }),
    );
  });

  it("validates the environment return URI under a custom prefix", async ({ tokens }) => {
    // GIVEN
    // WHEN
    const built = await tokens.loginProvider({ variablePrefix: "STAFF_OIDC" }, false, {
      STAFF_OIDC_POST_LOGOUT_REDIRECT_URI: "//unregistered.example",
    });
    // THEN
    expect(built).toBeErrWith(
      expect.objectContaining({
        _tag: "ConfigInvalid",
        issues: [
          {
            message: "must be an absolute HTTP(S) URI without credentials or a fragment",
            path: ["STAFF_OIDC_POST_LOGOUT_REDIRECT_URI"],
          },
        ],
      }),
    );
  });
});
