import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("request metadata", () => {
  it("isolates concurrent RPC units for the same principal", async ({ metadata }) => {
    // GIVEN
    const first = "fr";
    const second = "en";

    // WHEN
    const answers = await Promise.all([metadata.call("rpc", first), metadata.call("rpc", second)]);

    // THEN
    expect(answers).toEqual([
      { json: { locale: "fr", direct: "fr", principal: "same-user", sameSignal: true } },
      { json: { locale: "en", direct: "en", principal: "same-user", sameSignal: true } },
    ]);
  });

  it("isolates concurrent OpenAPI units for the same principal", async ({ metadata }) => {
    // GIVEN
    const first = "fr";
    const second = "en";

    // WHEN
    const answers = await Promise.all([
      metadata.call("openapi", first),
      metadata.call("openapi", second),
    ]);

    // THEN
    expect(answers).toEqual([
      { locale: "fr", direct: "fr", principal: "same-user", sameSignal: true },
      { locale: "en", direct: "en", principal: "same-user", sameSignal: true },
    ]);
  });

  it("provides metadata to an anonymous request unit", async ({ metadata }) => {
    // GIVEN a public route with no credential

    // WHEN
    const answer = await metadata.anonymous();

    // THEN
    expect(answer).toBe("fr");
  });

  it("aborts the metadata signal when the client disconnects", async ({ metadata }) => {
    // GIVEN a request waiting inside its handler

    // WHEN
    const answer = await metadata.cancelled();

    // THEN
    expect(answer).toBe(true);
  });
});
