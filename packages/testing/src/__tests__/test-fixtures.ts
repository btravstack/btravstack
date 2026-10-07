import { start, type RunningApp, type Runtime } from "@btravstack/core";
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

class KindGreeter extends Port("UnitKindGreeter")<{ readonly text: string }> {}
class KindSibling extends Port("UnitKindSibling")<{ readonly text: string }> {}

/** A provider for `port` that records `name` in `built` as it is constructed. */
const recordingProvider = (
  built: string[],
  port: typeof KindGreeter | typeof KindSibling,
  name: string,
) =>
  Provider(port)({
    inject: {},
    sync: () => {
      built.push(name);
      return { text: name };
    },
  });

/** A unit module building a greeter beside a sibling, each recording its build. */
const greetingKind = (built: string[]) =>
  Module("UnitKind")({
    provides: [
      recordingProvider(built, KindSibling, "sibling"),
      recordingProvider(built, KindGreeter, "real"),
    ],
    exports: [KindGreeter],
  });

/** What a spec about an override inside a unit module is handed. */
export type UnitKindKit = {
  /** What the kit's providers recorded as they were built, in order. */
  readonly built: () => readonly string[];
  /** A unit module building a greeter beside a sibling. */
  readonly kind: ReturnType<typeof greetingKind>;
  /** A unit module providing the sibling alone, and no greeter. */
  readonly unrelated: Module<KindSibling, never, never>;
  /** An override for `kind`'s greeter, recording `name` when it is built. */
  readonly stub: (name: string) => Provider<never, never, never>;
  /** A root providing `runtime` on `TestRuntimePort`. */
  readonly rootOf: typeof runtimeModule;
  /**
   * Starts a module with signals, probes and events off, and stops it when the
   * test ends — without failing on a defect, since a boot defect is what a
   * drift spec asserts.
   */
  readonly start: Boot;
};

/** The package's own `bootFixture`, dogfooded: every app a spec boots is stopped by the fixture. */
export const it = test.extend<{ boot: Boot; issuer: LocalIssuer; unitKind: UnitKindKit }>({
  boot: bootFixture(),
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  unitKind: async ({}, use) => {
    const built: string[] = [];
    const started: RunningApp<unknown, unknown>[] = [];
    await use({
      built: () => built,
      kind: greetingKind(built),
      unrelated: Module("UnitKindUnrelated")({
        provides: [recordingProvider(built, KindSibling, "sibling")],
        exports: [KindSibling],
      }),
      stub: (name) => recordingProvider(built, KindGreeter, name),
      rootOf: runtimeModule,
      // The gate is proven at each call site and invisible here, as in `bootFixture`.
      start: ((module: never) => {
        const app = (
          start as unknown as (module: never, options: object) => RunningApp<unknown, unknown>
        )(module, { signals: false, probes: false, onEvent: () => {} });
        started.push(app);
        return app;
      }) as unknown as Boot,
    });
    for (const app of started) {
      app.stop();
      await app.exited;
    }
  },
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
