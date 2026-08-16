import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("HttpController", () => {
  it("carries the port it minted, under the name it was given", async ({ controllers }) => {
    // GIVEN a controller declared over a fragment of the contract
    const { controller } = controllers;

    // WHEN the provider is inspected
    // THEN it carries a port under the given name, and the deps it declared
    expect({
      portId: controller.port.portId,
      deps: controller.deps.map((dep) => dep.portId),
    }).toEqual({ portId: "HelloController", deps: ["Greeter"] });
  });
});
