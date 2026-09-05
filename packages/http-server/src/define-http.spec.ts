import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { HttpAuthenticator } from "./auth.js";
import { defineHttp } from "./define-http.js";

describe("defineHttp", () => {
  it("mints one principal port per declared scheme", () => {
    // GIVEN an application declaring two schemes
    const api = defineHttp({
      authenticators: {
        reader: HttpAuthenticator<{ readonly userId: string }>()({
          inject: {},
          sync: () => () => OkAsync({ userId: "u-1" }),
        }),
        writer: HttpAuthenticator<{ readonly appId: string }>()({
          inject: {},
          sync: () => () => OkAsync({ appId: "a-1" }),
        }),
      },
    });

    // WHEN the principals are read back
    // THEN each carries the port id its scheme name mints
    expect(Object.entries(api.principals).map(([scheme, port]) => [scheme, port.portId])).toEqual([
      ["reader", "HttpPrincipal:reader"],
      ["writer", "HttpPrincipal:writer"],
    ]);
  });

  it("mints one port per scheme id, however many registries name it", () => {
    // GIVEN two registries declaring the same scheme name
    const authenticators = {
      reader: HttpAuthenticator<{ readonly userId: string }>()({
        inject: {},
        sync: () => () => OkAsync({ userId: "u-1" }),
      }),
    };
    const first = defineHttp({ authenticators });

    // WHEN a second registry declares it
    const second = defineHttp({ authenticators });

    // THEN both reach the same port, so a unit module depending on one is met
    // by the other — di identifies a port by id, and a second `Port(id)` call
    // would cost its duplicate-id warning
    expect(second.principals.reader).toBe(first.principals.reader);
  });

  it("retypes the same object rather than rebuilding it", () => {
    // GIVEN an application with no authenticators
    const api = defineHttp();

    // WHEN the kinds are bound
    // THEN the second step hands back the very object the first built
    expect(api.units()).toBe(api);
  });
});
