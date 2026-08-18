import type { UnitMeta } from "@btravstack/core";
import { Module } from "@btravstack/di";

import { bootFixture } from "./boot-fixture.js";
import { TestRuntimePort, testRuntime } from "./test-runtime.js";

/**
 * Runs `work` inside a real kernel unit, and answers whatever it answers.
 *
 * `meta` fills in what the caller cares about; `kind` and `id` default to a
 * test's and `id` stays unique per call, so the record's `unitId` and
 * `traceId` behave the way a runtime's would.
 */
export type InUnit = <T>(meta: Partial<UnitMeta>, work: () => T | Promise<T>) => Promise<T>;

/**
 * A `test.extend` fixture for testing the code that **reads** the ambient
 * record: a database adapter stamping `tenantId` on a query, a logger
 * correlating on `traceId`, anything reaching for `currentUnit()`.
 *
 * ```ts
 * export const it = test.extend<{ inUnit: InUnit }>({ inUnit: unitFixture() });
 *
 * it("scopes the read to the unit's tenant", async ({ inUnit, repository }) => {
 *   await expect(inUnit({ tenantId: "acme" }, () => repository.find("o-1"))).resolves.toBeOk();
 * });
 * ```
 *
 * The unit is the kernel's own, opened through `RuntimeHost.run` exactly as a
 * transport would open one — not an `AsyncLocalStorage` the harness runs
 * beside it. That is the point: a fabricated record could drift from the one
 * `units.ts` mints, and the whole value of testing an ambient reader is that
 * it saw the real thing. The runtime underneath is {@link testRuntime}, booted
 * once per test by {@link bootFixture} and stopped with it.
 *
 * `work`'s result is passed straight back and its throw is rethrown, so an
 * `expect` inside one reaches the test runner. What it must NOT do is outlive
 * the call — a unit is closed the instant its work settles, which is the
 * kernel's own contract, and a promise started inside one and awaited outside
 * is reading a record that has already gone.
 */
export const unitFixture =
  () =>
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  async ({}: object, use: (inUnit: InUnit) => Promise<void>): Promise<void> => {
    const runtime = testRuntime("unit-fixture");
    const boot = bootFixture();

    await boot({}, async (start) => {
      const app = start(
        Module("UnitFixture")({ imports: [runtime.module], exports: [TestRuntimePort] }),
      );
      await app.runtimeInfo();

      await use((meta, work) => runtime.inUnit(meta, work));
    });
  };
