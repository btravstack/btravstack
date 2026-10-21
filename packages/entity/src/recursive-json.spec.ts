import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Entity } from "./entity.js";

describe("recursive json creation inputs", () => {
  it("should transfer a frozen recursive value through a factory", () => {
    // GIVEN
    const Payload = z.json().brand("Payload");
    class Source extends Entity("Source")({ data: Payload }) {}
    class Target extends Entity("Target")({ data: Payload }) {}
    const source = Source.make({ data: { nested: [1, { enabled: true }] } }).getOrThrow();
    const create = Target.factory({});

    // WHEN
    const result = create({ data: source.data });

    // THEN
    expect(
      result.map((target) => ({
        data: target.data,
        frozen: Object.isFrozen(target.data),
      })),
    ).toBeOkWith({ data: { nested: [1, { enabled: true }] }, frozen: true });
  });
});
