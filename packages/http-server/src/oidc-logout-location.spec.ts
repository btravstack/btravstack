import { Configuration } from "openid-client";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { logoutLocation } from "./oidc-logout-location.js";

describe("oidc logout destination", () => {
  it("retains the local fallback when discovery advertises no logout endpoint", () => {
    // GIVEN
    const configuration = new Configuration({ issuer: "https://issuer.example" }, "staff");
    // WHEN
    const location = logoutLocation(
      configuration,
      "/signed-out",
      "https://app.example/registered",
      { idToken: "private-hint" },
    );
    // THEN
    expect(location).toBe("/signed-out");
  });

  it("keeps a configured return out of parameterless logout without a retained hint", () => {
    // GIVEN
    const configuration = new Configuration(
      { issuer: "https://issuer.example", end_session_endpoint: "https://issuer.example/logout" },
      "staff",
    );
    // WHEN
    const location = logoutLocation(
      configuration,
      "/signed-out",
      "https://app.example/registered",
      undefined,
    );
    // THEN
    expect(location).toBe("https://issuer.example/logout?client_id=staff");
  });

  it("keeps existing deployments parameterless even when a hint is retained", () => {
    // GIVEN
    const configuration = new Configuration(
      { issuer: "https://issuer.example", end_session_endpoint: "https://issuer.example/logout" },
      "staff",
    );
    // WHEN
    const location = logoutLocation(configuration, "/signed-out", undefined, {
      idToken: "private-hint",
    });
    // THEN
    expect(location).toBe("https://issuer.example/logout?client_id=staff");
  });
});
