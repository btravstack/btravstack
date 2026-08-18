import type { Runtime } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { test } from "vitest";

import { bootFixture, type Boot } from "./boot-fixture.js";
import { TestRuntimePort, testRuntime, type TestRuntimeInfo } from "./test-runtime.js";
import { unitFixture, type InUnit } from "./unit-fixture.js";

/**
 * A wrapped or ad-hoc runtime as the module `start` boots — the shape
 * `TestRuntime.module` already has for the plain one, for a runtime a spec
 * built by hand (`{ ...testRuntime(), start }`, whose spread `.module` still
 * provides the inner runtime).
 */
export const runtimeModule = (runtime: Runtime<never, TestRuntimeInfo>) =>
  Module("TestRuntime")({
    provides: [Provider(TestRuntimePort)({ value: runtime })],
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
      provides: [Provider(Greeting)({ value: { text: "hello" } })],
      exports: [Greeting, TestRuntimePort],
    }),
  };
};

/** The package's own `bootFixture` and `unitFixture`, dogfooded: every app a spec boots is stopped by the fixture, and `inUnit` is the subject of `unit-fixture.spec.ts`. */
export const it = test.extend<{ boot: Boot; inUnit: InUnit }>({
  boot: bootFixture(),
  inUnit: unitFixture(),
});
