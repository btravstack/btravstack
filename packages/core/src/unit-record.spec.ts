import { Module, Port } from "@btravstack/di";
import { ErrAsync, OkAsync, TaggedError, type AsyncResult } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import type { RuntimeHost, UnitHost } from "./runtime.js";
import { dispatchUnit, withUnitRecord } from "./unit-record.js";

describe("dispatchUnit and withUnitRecord", () => {
  it("hands a piece the forked context through the record it declared", async () => {
    // GIVEN a host whose fork answers a context holding the tenant, and a piece
    // declaring `tenant` on its unit record
    class Tenant extends Port("UnitRecordTenant")<string> {}
    class Seed extends Port("UnitRecordSeed")<string> {}
    const seeded: unknown[] = [];
    const scope = {
      fork: (_module: unknown, seed: unknown) => {
        seeded.push(seed);
        return OkAsync({ get: () => "tenant-a" });
      },
    } as unknown as UnitHost<never>;
    const host = {
      run: (_meta: unknown, work: (unit: UnitHost<never>) => unknown) => work(scope),
    } as unknown as RuntimeHost<never>;
    const piece = withUnitRecord(
      { tenant: Tenant },
      (helpers: { readonly context: { readonly unit: { readonly tenant: string } } }) =>
        OkAsync(helpers.context.unit.tenant),
    );

    // WHEN a unit is dispatched with a unit module bound
    const tenant = dispatchUnit({
      host,
      observers: [],
      operation: { component: "test", name: "unit", attributes: {} },
      meta: { kind: "test", id: "u-1" },
      unit: Module("UnitRecordUnit")({}) as never,
      seed: [Seed, "the message"],
      next: (overrides) => piece(overrides ?? {}, undefined as never) as AsyncResult<string, never>,
    });

    // THEN the piece read the forked tenant, and the fork was seeded with the
    // one entry the worker handed over
    await expect(tenant.map((value) => ({ value, seeded }))).toBeOkWith({
      value: "tenant-a",
      seeded: [[[Seed, "the message"]]],
    });
  });

  it("calls next unchanged and hands the piece an empty record when no unit is bound", async () => {
    // GIVEN a host, and a piece declaring a port no fork will ever resolve
    class Tenant extends Port("UnitRecordUnbound")<string> {}
    const host = {
      run: (_meta: unknown, work: (unit: UnitHost<never>) => unknown) => work({} as never),
    } as unknown as RuntimeHost<never>;
    const piece = withUnitRecord(
      { tenant: Tenant },
      (helpers: { readonly context: { readonly unit: unknown } }) => OkAsync(helpers.context.unit),
    );

    // WHEN a unit is dispatched with no unit module bound
    const unit = dispatchUnit({
      host,
      observers: [],
      operation: { component: "test", name: "unit", attributes: {} },
      meta: { kind: "test", id: "u-2" },
      unit: undefined,
      seed: [Tenant, "unused"],
      next: (overrides) =>
        piece(overrides ?? {}, undefined as never) as AsyncResult<unknown, never>,
    });

    // THEN the record is empty whatever was declared — there is nothing to
    // resolve from
    await expect(unit).toBeOkWith({});
  });

  it("settles the observers as an error when the unit comes back on its error channel", async ({
    recording,
  }) => {
    // GIVEN a host, and work that answers an Err
    class Refused extends TaggedError("UnitRecordRefused")<{ readonly reason: string }> {}
    const refused = new Refused({ reason: "no" });
    const host = {
      run: (_meta: unknown, work: (unit: UnitHost<never>) => unknown) => work({} as never),
    } as unknown as RuntimeHost<never>;

    // WHEN the unit is dispatched
    await dispatchUnit({
      host,
      observers: [recording.observer],
      operation: { component: "test", name: "unit", attributes: {} },
      meta: { kind: "test", id: "u-3" },
      unit: undefined,
      seed: [Port("UnitRecordSeedless"), undefined],
      next: () => ErrAsync(refused),
    });

    // THEN the observer saw the error, carrying the refusal as its cause
    expect(recording.seen).toEqual([{ outcome: "error", cause: refused }]);
  });
});
