import { describe, expect } from "vitest";

import { Greeting, greetingApp, it } from "./__tests__/test-fixtures.js";
import { tapped } from "./tapped.js";

describe("tapped", () => {
  it("hands back the very service the booted graph was built with", async ({ boot }) => {
    // GIVEN an application tapped on one of its exported ports
    const { runtime, module } = greetingApp();
    const tap = tapped(module, [Greeting]);

    // WHEN it is booted and serving
    boot(tap.module);
    await runtime.untilStarted();

    // THEN the tap answers the service instance the graph holds
    expect(tap.services()).toEqual([{ text: "hello" }]);
  });

  it("is loud when read before the graph is built", () => {
    // GIVEN a tapped application nobody has booted
    const tap = tapped(greetingApp().module, [Greeting]);

    // WHEN the services are read
    // THEN the misuse is a throw, not an undefined a test could swallow
    expect(() => tap.services()).toThrow("before the graph was built");
  });
});
