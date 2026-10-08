import { Module } from "@btravstack/di";
import { html } from "@btravstack/htmx-server";
import { HttpAuthenticator } from "@btravstack/http-server";
import { it } from "@btravstack/internal-http-fixtures";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

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
  it("refuses two routes on one method and path as a duplicate provider", async () => {
    // GIVEN two GET routes minted on the same path
    const api = defineHttp();
    const first = api.HtmxGet("/dup")({ inject: {}, sync: () => () => OkAsync(html`a`) });
    const second = api.HtmxGet("/dup")({ inject: {}, sync: () => () => OkAsync(html`b`) });
    const composed = api.HtmxFragments([first, second]);

    // WHEN a graph composes both — each piece registered alongside the
    // composed provider, exactly as any other piece is. `Module.build`
    // directly, not `boot`: the harness's own teardown fails a test on ANY
    // Defect it sees, which is the exact outcome this test asserts.
    const built = await Module.build(Module("Dup")({ provides: [first, second, composed] }));

    // THEN di refuses the build: one port id, two providers
    expect(built).toBeDefectWith(
      expect.objectContaining({ message: expect.stringContaining("two providers") }),
    );
  });
});
