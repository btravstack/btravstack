import type { Runtime } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { test } from "vitest";

import { bootFixture, type Boot } from "../boot-fixture.js";
import { localIssuer, type LocalIssuer } from "../jwt.js";
import { TestRuntimePort, testRuntime, type TestRuntimeInfo } from "../test-runtime.js";

/**
 * A wrapped or ad-hoc runtime as the module `start` boots — the shape
 * `TestRuntime.module` already has for the plain one, for a runtime a spec
 * built by hand (`{ ...testRuntime(), start }`, whose spread `.module` still
 * provides the inner runtime).
 */
export const runtimeModule = (runtime: Runtime<never, TestRuntimeInfo>) =>
  Module("TestRuntime")({
    provides: [Provider(TestRuntimePort)({ inject: {}, value: runtime })],
    exports: [TestRuntimePort],
  });

/** A service to tap: the module below provides it next to an in-memory runtime, so a spec can read it back out of the booted graph. */
export class Greeting extends Port("TestingFixtureGreeting")<{ readonly text: string }> {}

/** An in-memory runtime next to a `Greeting`, both exported — what `tapped` and `boot` are exercised against. */
export const greetingApp = () => {
  const runtime = testRuntime();
  return {
    runtime,
    module: Module("GreetingApp")({
      imports: [runtime.module],
      provides: [Provider(Greeting)({ inject: {}, value: { text: "hello" } })],
      exports: [Greeting, TestRuntimePort],
    }),
  };
};

/** The package's own `bootFixture`, dogfooded: every app a spec boots is stopped by the fixture. */
export const it = test.extend<{ boot: Boot; issuer: LocalIssuer }>({
  boot: bootFixture(),
  // File-scoped: built once and shared by every test in `jwt.spec.ts` that
  // only reads it, closed once the file is done. A test that closes an
  // issuer itself mints its own instead of reaching for this one.
  issuer: [
    // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
    async ({}, use) => {
      const built = await localIssuer({
        issuer: "https://issuer.test",
        audience: "orders-api",
      }).get();
      await use(built);
      await built.close();
    },
    { scope: "file" },
  ],
});
