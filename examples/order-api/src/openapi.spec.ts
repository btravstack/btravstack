import { describe, expect, it } from "vitest";

import { openApi } from "./openapi.js";

describe("the API's OpenAPI document", () => {
  it("protects the marked orders and leaves the customers open", async () => {
    // GIVEN the real contract this deployment serves
    const document = (await openApi()).get();

    // WHEN its operations are read back
    const security = Object.fromEntries(
      Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
        Object.values(item as Record<string, { security?: unknown }>).map((operation) => [
          path,
          operation.security,
        ]),
      ),
    );

    // THEN every orders route names the schemes its contract marked, the
    // customers routes name none, and the schemes are defined once
    // Exact, not `objectContaining`: a partial match would pass just as well if
    // a path went missing, which is the failure this test exists to catch.
    // `/orders/export` is the load-bearing row — it carries OR across two
    // schemes AND a scope, straight out of the real contract.
    expect({ security, schemes: Object.keys(document.components?.securitySchemes ?? {}) }).toEqual({
      security: {
        "/orders/place": [{ user: [] }],
        "/orders/find": [{ user: [] }],
        "/orders/export": [{ user: ["orders:export"] }, { service: [] }],
        "/customers/find": undefined,
      },
      schemes: ["user", "service"],
    });
  });
});
