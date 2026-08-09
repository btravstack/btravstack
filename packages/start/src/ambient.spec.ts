import { describe, expect, it } from "vitest";

import { currentUnit, runWithUnit } from "./ambient.js";

const record = {
  unitId: "u-1",
  traceId: "t-1",
  tenantId: "acme",
  deadline: undefined,
} as const;

describe("ambient unit record", () => {
  it("is undefined outside a unit", () => {
    expect(currentUnit()).toBeUndefined();
  });

  it("is readable inside a unit", () => {
    const seen = runWithUnit(record, () => currentUnit());
    expect(seen).toEqual(record);
  });

  it("survives an await boundary", async () => {
    const seen = await runWithUnit(record, async () => {
      await Promise.resolve();
      return currentUnit();
    });
    expect(seen?.unitId).toBe("u-1");
  });

  it("does not leak between concurrent units", async () => {
    const [a, b] = await Promise.all([
      runWithUnit({ ...record, unitId: "a" }, async () => {
        await Promise.resolve();
        return currentUnit()?.unitId;
      }),
      runWithUnit({ ...record, unitId: "b" }, async () => {
        await Promise.resolve();
        return currentUnit()?.unitId;
      }),
    ]);

    expect([a, b]).toEqual(["a", "b"]);
  });
});
