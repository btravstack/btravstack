import { currentUnit, type UnitRecord } from "@btravstack/core";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("unitFixture", () => {
  it("runs the work inside a real kernel unit", async ({ inUnit }) => {
    // GIVEN nothing but the fixture — no transport, no application
    // WHEN a callback reads the ambient record from inside it
    const seen = await inUnit({}, () => currentUnit());

    // THEN it is the kernel's own record, minted by `units.ts` rather than
    // fabricated here: `unitId` is always present and always unique, and
    // `traceId` defaults to the meta's `id`
    expect(seen).toEqual(
      expect.objectContaining({
        unitId: expect.any(String),
        traceId: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("puts the tenant the caller named on that record", async ({ inUnit }) => {
    // GIVEN a meta carrying a tenant — what a multi-tenant runtime supplies
    // WHEN an adapter-shaped reader looks for it
    const seen = await inUnit({ tenantId: "acme", traceId: "t-1" }, () => currentUnit());

    // THEN both travel, which is the whole reason this fixture exists: it is
    // how the code that READS the ambient record gets tested
    expect(seen).toEqual(expect.objectContaining({ tenantId: "acme", traceId: "t-1" }));
  });

  it("gives each call a unit of its own", async ({ inUnit }) => {
    // GIVEN two separate calls
    const first = await inUnit({}, () => currentUnit());
    const second = await inUnit({}, () => currentUnit());

    // WHEN their ids are compared
    // THEN they are different units, so nothing leaks from one to the next
    expect({ same: first?.unitId === second?.unitId }).toEqual({ same: false });
  });

  it("hands back what the work answered", async ({ inUnit }) => {
    // GIVEN work with a value to return
    // WHEN it is run
    // THEN the value comes straight back, so a caller can assert on it
    await expect(inUnit({}, () => Promise.resolve(42))).resolves.toBe(42);
  });

  it("rethrows what the work threw, so a failing assertion reaches the runner", async ({
    inUnit,
  }) => {
    // GIVEN work that fails the way an `expect` inside a unit fails
    const failing = inUnit({}, () => {
      // oxlint-disable-next-line unthrown/no-throw -- the subject under test: a throw inside the unit is what must reach the caller rather than being folded into the unit's `Result`
      throw new Error("assertion failed inside the unit");
    });

    // WHEN it is awaited
    // THEN it rejects with the original cause — folded into the unit's
    // `Result` instead, it would be a `Defect` a caller could forget to
    // unwrap: a green test that asserted nothing
    await expect(failing).rejects.toThrow("assertion failed inside the unit");
  });

  it("leaves no ambient record behind once the work has settled", async ({ inUnit }) => {
    // GIVEN a unit that has already run
    await inUnit({ tenantId: "acme" }, () => currentUnit());

    // WHEN the record is read from outside it
    const outside: UnitRecord | undefined = currentUnit();

    // THEN there is none: a unit is closed the instant its work settles, which
    // is why `inUnit`'s work must not outlive the call
    expect(outside).toBeUndefined();
  });
});
