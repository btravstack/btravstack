import { Module, Provider } from "@btravstack/di";
// Side-effect import for `tsc`'s benefit only — see the identical note in
// hexagonal-order-api's `index.spec.ts`.
import "@unthrown/vitest";
import { OkAsync } from "unthrown";
import { expect, test } from "vitest";

import { AppModule, HealthCheck, runHealthChecks } from "./index.js";

test("contributions accumulate across module boundaries", async () => {
  const built = await Module.build(AppModule);
  expect(built).toBeOk();

  const names = built.isOk()
    ? built.value
        .get(HealthCheck)
        .map((check) => check.name)
        .toSorted()
    : [];
  // `HealthCheck` was never declared in `AppModule.provides` — every member
  // came from `DatabaseModule` or `CacheModule`, and both are present.
  expect(names).toEqual(["cache", "database"]);
});

test("the registry runs every contribution and reports a failure as data, not an exception", async () => {
  const built = await Module.build(AppModule);
  const checks = built.isOk() ? built.value.get(HealthCheck) : [];

  const reports = await runHealthChecks(checks);

  expect(reports.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: "cache", status: "unhealthy", reason: "connection refused" },
    { name: "database", status: "healthy" },
  ]);
});

test("a third module contributes to the same set port without either existing one changing", async () => {
  const QueueModule = Module("Queue")({
    provides: [
      Provider.member(HealthCheck)({ value: { name: "queue", run: () => OkAsync("healthy") } }),
    ],
    exports: [HealthCheck],
  });
  const extended = Module("ExtendedApp")({
    imports: [AppModule, QueueModule],
    exports: [AppModule, QueueModule],
  });

  const built = await Module.build(extended);
  const names = built.isOk()
    ? built.value
        .get(HealthCheck)
        .map((check) => check.name)
        .toSorted()
    : [];
  expect(names).toEqual(["cache", "database", "queue"]);
});
