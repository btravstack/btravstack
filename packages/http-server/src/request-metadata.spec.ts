import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { requestMetadataOf } from "./request-metadata.js";

describe("request metadata snapshot", () => {
  it("keeps immutable metadata when the incoming request is subsequently changed", ({
    incoming,
  }) => {
    // GIVEN
    incoming.headers = { "x-locale": "fr", "set-cookie": ["first", "second"] };
    incoming.method = "GET";
    incoming.url = "/orders?locale=fr";
    const controller = new AbortController();
    const metadata = requestMetadataOf(incoming, controller.signal);

    // WHEN
    incoming.headers["x-locale"] = "en";
    incoming.headers["set-cookie"]?.push("third");
    incoming.method = "POST";
    incoming.url = "/changed";

    // THEN
    expect({
      metadata,
      frozen: Object.isFrozen(metadata),
      headersFrozen: Object.isFrozen(metadata.headers),
      cookiesFrozen: Object.isFrozen(metadata.headers["set-cookie"]),
    }).toEqual({
      metadata: {
        headers: { "x-locale": "fr", "set-cookie": ["first", "second"] },
        method: "GET",
        url: "/orders?locale=fr",
        signal: controller.signal,
      },
      frozen: true,
      headersFrozen: true,
      cookiesFrozen: true,
    });
  });
});
