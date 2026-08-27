import { Config, Env, type ConfigInvalid, type Environment } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import {
  bootFixture,
  testRuntime,
  type Boot,
  type TestRuntime,
  type TestRuntimeInfo,
  TestRuntimePort,
} from "@btravstack/testing";
import { OkAsync } from "unthrown";
import { expect, test } from "vitest";

import type { KernelEvent } from "../events.js";
import { runMain } from "../run-main.js";
import type { Runtime } from "../runtime.js";
import { start, type RunningApp } from "../start.js";
import { currentUnit } from "../units.js";

class Parent extends Port("UnitFixtureParent")<{ readonly mark: () => void }> {}
class Span extends Port("UnitFixtureSpan")<{ readonly openedIn: string | undefined }> {}

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

class Settings extends Port("ConfigFixtureSettings")<{
  readonly port: number;
  readonly host: string;
  readonly retries: number;
}> {}

/** The slice of environment `configuredApp` binds onto `Settings`. */
export const settingsSchema = Config.object({
  port: Config.port("PORT", { default: 3000 }),
  host: Config.string("HOST", { default: "0.0.0.0" }),
  retries: Config.integer("RETRIES", { min: 0, max: 10, default: 3 }),
});

export type ConfiguredApp = {
  /**
   * Boots a module whose `Settings` port is bound from `env` through
   * `settingsSchema`, next to an in-memory runtime — the binding itself is
   * `@btravstack/config`'s spec's business; what this app shows is how the
   * kernel reports it.
   */
  readonly boot: (env: Environment) => RunningApp<ConfigInvalid, TestRuntimeInfo>;
  /**
   * The same module through `runMain`, resolving the exit code it set. Probes
   * are off unless `probesFromEnv` asks the kernel to bind them from `env`.
   */
  readonly exitCodeFor: (env: Environment, probesFromEnv?: boolean) => Promise<number>;
  /** An in-memory runtime alone, with the kernel binding its probe server from `env`. Shut down by the fixture. */
  readonly probesFrom: (env: Environment) => RunningApp<never, TestRuntimeInfo>;
  /**
   * The durations the kernel's own drain slept, with its timings bound from
   * `env` — the pre-drain delay, then the drain deadline. A stub clock, so the
   * assertion is on what was asked for rather than on wall time.
   */
  readonly drainSleepsFor: (env: Environment) => Promise<readonly number[]>;
};

const settingsApp = () =>
  Module("ConfigFixtureApp")({
    // This module provides the config provider itself, so `Env` is its own
    // provider's need rather than one inherited from an import.
    needs: [Env],
    imports: [testRuntime().module],
    provides: [Config.provider(Settings)(settingsSchema)],
    exports: [TestRuntimePort, Settings],
  });

export type UnitApp = {
  readonly runtime: TestRuntime;
  readonly app: RunningApp<never, TestRuntimeInfo>;
  /** Mutated live by the providers; a test reads it after its units settle. */
  readonly counts: { parentBuilds: number; spanBuilds: number; spanStops: number };
  /** What `currentUnit()` answered inside the unit provider's build and stop. */
  readonly seen: { build: string | undefined; stop: string | undefined };
  /** Every kernel event the application emitted, in order. */
  readonly events: readonly KernelEvent[];
  /** Holds every subsequent unit teardown open until the returned `release` is called. */
  readonly holdTeardown: () => { readonly release: () => void };
  /** Makes every subsequent unit teardown fail with `cause`. */
  readonly failTeardown: (cause: unknown) => void;
};

/**
 * A serving application whose `StartOptions` carry a `unit` module: `Span` is
 * constructed as each unit opens — reading `Parent` out of the application
 * scope — and torn down as it closes, with both moments recording what the
 * ambient `currentUnit()` saw. The ports are module-level (a `Port` id warns
 * on re-declaration) while the providers, and therefore the counters, are
 * fresh per test.
 */
export const it = test.extend<{ boot: Boot; unitApp: UnitApp; configured: ConfiguredApp }>({
  boot: bootFixture(),

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  configured: async ({}, use) => {
    const started: RunningApp<ConfigInvalid, TestRuntimeInfo>[] = [];

    await use({
      boot: (env) => {
        const app = start(settingsApp(), { env, signals: false, probes: false, onEvent: () => {} });
        started.push(app);
        return app;
      },
      probesFrom: (env) => {
        const app = start(testRuntime().module, { env, signals: false, onEvent: () => {} });
        started.push(app);
        return app;
      },
      drainSleepsFor: async (env) => {
        const slept: number[] = [];
        const app = start(testRuntime().module, {
          env,
          signals: false,
          clock: {
            now: () => 0,
            sleep: (ms) => {
              slept.push(ms);
              return OkAsync();
            },
          },
          onEvent: () => {},
        });
        started.push(app);
        await app.runtimeInfo();
        app.requestDrain();
        await app.exited;
        return slept;
      },
      exitCodeFor: async (env, probesFromEnv = false) => {
        let code = -1;
        await runMain(
          settingsApp(),
          { env, signals: false, ...(probesFromEnv ? {} : { probes: false }), onEvent: () => {} },
          (c) => {
            code = c;
          },
        );
        return code;
      },
    });

    for (const app of started) {
      app.stop();
      await app.exited;
    }
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  unitApp: async ({}, use) => {
    const counts = { parentBuilds: 0, spanBuilds: 0, spanStops: 0 };
    const seen: { build: string | undefined; stop: string | undefined } = {
      build: undefined,
      stop: undefined,
    };
    const events: KernelEvent[] = [];
    let teardown: () => Promise<void> | undefined = () => undefined;
    const holdTeardown = (): { readonly release: () => void } => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      teardown = () => held;
      return { release: () => release() };
    };
    const failTeardown = (cause: unknown): void => {
      teardown = () => Promise.reject(cause);
    };

    const runtime = testRuntime();
    const AppModule = Module("UnitFixtureApp")({
      imports: [runtime.module],
      provides: [
        Provider(Parent)({
          sync: () => {
            counts.parentBuilds += 1;
            return { mark: () => {} };
          },
        }),
      ],
      exports: [Parent, TestRuntimePort],
    });

    const UnitModule = Module("UnitFixtureUnit")({
      // The fork seam: `Parent` comes from the application scope this unit
      // module is forked from, never from inside it.
      needs: [Parent],
      provides: [
        Provider(Span)(
          { parent: Parent },
          {
            sync: () => {
              counts.spanBuilds += 1;
              seen.build = currentUnit()?.unitId;
              return { openedIn: seen.build };
            },
            onStop: () => {
              counts.spanStops += 1;
              seen.stop = currentUnit()?.unitId;
              return teardown();
            },
          },
        ),
      ],
      exports: [Span],
    });

    const app = start(AppModule, {
      unit: UnitModule,
      signals: false,
      probes: false,
      preDrainDelayMs: 0,
      onEvent: (event) => {
        events.push(event);
      },
    });
    await runtime.untilStarted();

    await use({ runtime, app, counts, seen, events, holdTeardown, failTeardown });

    app.stop();
    await expect(app.exited).toBeOk();
  },
});
