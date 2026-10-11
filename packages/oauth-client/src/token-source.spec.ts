import { Module } from "@btravstack/di";
import { allAsync } from "unthrown";
import { describe, expect } from "vitest";

import { AUDIENCE, it } from "./__tests__/test-fixtures.js";
import { TokenSource, staticTokenSource } from "./token-source.js";

describe("staticTokenSource", () => {
  it("answers the same bearer for every request", async () => {
    // GIVEN the in-process source
    const Root = Module("StaticTokens")({
      provides: [staticTokenSource("a-token")],
      exports: [TokenSource],
    });

    // WHEN it is asked for two different tokens
    const answers = await Module.scoped(Root, (ctx) => {
      const source = ctx.get(TokenSource);
      return allAsync([
        source.token({ audience: AUDIENCE }),
        source.token({ audience: "https://elsewhere.example.test", scope: "any" }),
      ]);
    });

    // THEN both are the bearer it was given
    expect(answers).toBeOkWith([{ bearer: "a-token" }, { bearer: "a-token" }]);
  });
});
