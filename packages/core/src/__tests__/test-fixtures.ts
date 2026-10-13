import { networkInterfaces } from "node:os";

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
import { Ok, OkAsync, type AsyncResult } from "unthrown";
import { expect, test } from "vitest";

import type { KernelEvent } from "../events.js";
import type { Operation, Settle, Settled } from "../observation.js";
import { runMain } from "../run-main.js";
import type { Runtime } from "../runtime.js";
import { start, type RunningApp } from "../start.js";
import type { AnyUnitModule } from "../unit-record.js";
import { currentUnit, unitOutcome, type UnitOutcome } from "../units.js";

class Parent extends Port("UnitFixtureParent")<{ readonly mark: () => void }> {}
class Span extends Port("UnitFixtureSpan")<{ readonly openedIn: string | undefined }> {}
class Greeter extends Port("UnitOverrideGreeter")<{ readonly text: string }> {}
class AppClient extends Port("ScopeFixtureClient")<{ readonly app: string }> {}
class RequestService extends Port("ScopeFixtureService")<Record<never, never>> {}
class Farewell extends Port("UnitOverrideFarewell")<{ readonly text: string }> {}

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
  /** The same, with the probe server off — the kernel still reads its other variables. */
  readonly withoutProbes: (env: Environment) => RunningApp<never, TestRuntimeInfo>;
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
  readonly runtime: TestRuntime<Module<never, never, Parent>>;
  readonly app: RunningApp<never, TestRuntimeInfo>;
  /** Mutated live by the providers; a test reads it after its units settle. */
  readonly counts: { parentBuilds: number; spanBuilds: number; spanStops: number };
  /** What `currentUnit()` answered inside the unit provider's build and stop. */
  readonly seen: { build: string | undefined; stop: string | undefined };
  /** What `unitOutcome()` answered inside each unit's onStop, in order. */
  readonly outcomes: readonly (UnitOutcome | undefined)[];
  /** Every kernel event the application emitted, in order. */
  readonly events: readonly KernelEvent[];
  /** Holds every subsequent unit teardown open until the returned `release` — or `fail` — is called. */
  readonly holdTeardown: () => {
    readonly release: () => void;
    readonly fail: (cause: unknown) => void;
  };
  /** Makes every subsequent unit teardown fail with `cause`. */
  readonly failTeardown: (cause: unknown) => void;
  /** Forks the unit module a second time inside one unit, over the running app's host. */
  readonly forkTwice: () => AsyncResult<unknown, never>;
  /** Forks a module whose provider fails to construct, over the running app's host. */
  readonly forkBroken: () => AsyncResult<unknown, never>;
  /**
   * Forks the unit module only once the unit's own work has already
   * returned — the shape an answerer racing a client's abort against its own
   * fork produces.
   */
  readonly forkAfterSettled: () => AsyncResult<unknown, never>;
};

/** A provider for `port` that records `name` in `built` as it is constructed. */
const recordingProvider = (built: string[], port: typeof Greeter | typeof Farewell, name: string) =>
  Provider(port)({
    inject: {},
    sync: () => {
      built.push(name);
      return { text: name };
    },
  });

/** A unit module providing a greeter and a farewell, each recording its build. */
const greetingKind = (built: string[]) =>
  Module("UnitOverrideKind")({
    provides: [
      recordingProvider(built, Greeter, "real greeter"),
      recordingProvider(built, Farewell, "real farewell"),
    ],
    exports: [Greeter, Farewell],
  });

export type UnitOverrideKit = {
  /** What the kit's providers recorded as they were built, in order. */
  readonly built: () => readonly string[];
  /** A unit module providing a greeter and a farewell, each recording its build. */
  readonly kind: ReturnType<typeof greetingKind>;
  /** A unit module providing neither port. */
  readonly empty: Module<never, never, never>;
  /** An override for one of `kind`'s two ports, recording `name` when it is built. */
  readonly stub: (port: "greeter" | "farewell", name: string) => Provider<never, never, never>;
  /** A root providing `runtime` on `TestRuntimePort` — `runtimeModule`, for a spec. */
  readonly rootOf: typeof runtimeModule;
  /**
   * Starts a module with signals, probes and events off, and stops it when the
   * test ends — without failing on a defect, since a boot defect is what these
   * specs assert.
   */
  readonly start: Boot;
};

/** What one application booted by `applicationScope` saw. */
export type ScopedApp = {
  readonly app: RunningApp<unknown, unknown>;
  readonly runtime: TestRuntime<AnyUnitModule>;
  /** Runs `count` units to completion, one after another. */
  readonly units: (count: number) => Promise<void>;
  /** How often the policy was parsed, what each unit read, and each scope's releases. */
  readonly seen: {
    parses: number;
    appStops: number;
    unitStops: number;
    readonly units: { readonly maxItems: number; readonly client: string }[];
  };
};

/**
 * Boots a root holding a configuration provider and a client, with a unit
 * module that injects both and declares no `needs`. `rebuilding` binds a unit
 * module that also provides the client, which the kernel must refuse.
 */
export type ApplicationScopeKit = {
  readonly boot: (
    env: Environment,
    options?: { readonly name?: string; readonly rebuilding?: boolean },
  ) => ScopedApp;
};

/** One observer that records every settlement it is handed, and the list it records into. */
export type Recording = {
  readonly seen: readonly Settled[];
  readonly observer: (operation: Operation) => Settle;
};

/**
 * A serving application whose runtime binds a `unit` module: `Span` is
 * constructed as each unit opens — reading `Parent` out of the application
 * scope — and torn down as it closes, with both moments recording what the
 * ambient `currentUnit()` saw. The ports are module-level (a `Port` id warns
 * on re-declaration) while the providers, and therefore the counters, are
 * fresh per test.
 */
export const it = test.extend<{
  boot: Boot;
  unitApp: UnitApp;
  configured: ConfiguredApp;
  recording: Recording;
  /**
   * One of this machine's own IPv4 addresses that is NOT loopback — the
   * closest thing a test has to a pod IP, and the only way to tell a
   * `0.0.0.0` bind apart from a `127.0.0.1` one from outside the process.
   */
  nonLoopbackHost: () => string;
  unitOverride: UnitOverrideKit;
  applicationScope: ApplicationScopeKit;
}>({
  boot: bootFixture(),

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  unitOverride: async ({}, use) => {
    const built: string[] = [];
    const started: RunningApp<unknown, unknown>[] = [];
    await use({
      built: () => built,
      kind: greetingKind(built),
      empty: Module("UnitOverrideEmpty")({ provides: [], exports: [] }),
      stub: (port, name) => recordingProvider(built, port === "greeter" ? Greeter : Farewell, name),
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

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  applicationScope: async ({}, use) => {
    const started: RunningApp<unknown, unknown>[] = [];
    await use({
      boot: (env, { name = "app", rebuilding = false } = {}) => {
        const seen: ScopedApp["seen"] = { parses: 0, appStops: 0, unitStops: 0, units: [] };
        const schema = Config.object({
          maxItems: Config.integer("APP_MAX_ITEMS", { min: 1 }),
        });
        const counted: typeof schema = {
          "~standard": {
            ...schema["~standard"],
            validate: (value) => {
              seen.parses += 1;
              return schema["~standard"].validate(value);
            },
          },
        };
        const policy = Config.provider("ScopeFixturePolicy")(counted);
        const client = Provider(AppClient)({
          inject: {},
          sync: () => ({ app: name }),
          onStop: () => {
            seen.appStops += 1;
          },
        });
        const service = Provider(RequestService)({
          inject: { policy: policy.port, client: AppClient },
          sync: ({ policy: { maxItems }, client: { app } }) => {
            seen.units.push({ maxItems, client: app });
            return {};
          },
          onStop: () => {
            seen.unitStops += 1;
          },
        });
        const unit = Module("ScopeFixtureRequest")({
          provides: rebuilding ? [client, service] : [service],
          exports: [RequestService],
        }) as unknown as AnyUnitModule;
        const runtime = testRuntime("test", { unit });
        const app = (
          start as unknown as (module: never, options: object) => RunningApp<unknown, unknown>
        )(
          Module("ScopeFixtureApp")({
            imports: [runtime.module],
            provides: [policy, client],
            exports: [TestRuntimePort],
          }) as never,
          { env, signals: false, probes: false, onEvent: () => {} },
        );
        started.push(app);
        const units = async (count: number): Promise<void> => {
          for (let index = 0; index < count; index += 1) {
            const submitted = runtime.submit();
            submitted.settle(Ok("done"));
            await submitted.result;
          }
        };
        return { app, runtime, units, seen };
      },
    });
    for (const app of started) {
      app.stop();
      await app.exited;
    }
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  nonLoopbackHost: async ({}, use) => {
    await use(() => {
      const address = Object.values(networkInterfaces())
        .flat()
        .find((candidate) => candidate?.family === "IPv4" && !candidate.internal)?.address;
      // oxlint-disable-next-line unthrown/no-throw -- a loud fixture: a machine with no external interface cannot prove this invariant either way, and a silent skip would read as coverage
      if (address === undefined) throw new Error("[test-fixtures] no non-loopback IPv4 interface");
      return address;
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  recording: async ({}, use) => {
    const seen: Settled[] = [];
    await use({
      seen,
      observer: () => (settled) => {
        seen.push(settled);
      },
    });
  },

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
      withoutProbes: (env) => {
        const app = start(testRuntime().module, {
          env,
          signals: false,
          probes: false,
          onEvent: () => {},
        });
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
    const outcomes: (UnitOutcome | undefined)[] = [];
    const events: KernelEvent[] = [];
    let teardown: () => Promise<void> | undefined = () => undefined;
    const holdTeardown = (): {
      readonly release: () => void;
      readonly fail: (cause: unknown) => void;
    } => {
      const held = Promise.withResolvers<void>();
      teardown = () => held.promise;
      return { release: () => held.resolve(), fail: (cause) => held.reject(cause) };
    };
    const failTeardown = (cause: unknown): void => {
      teardown = () => Promise.reject(cause);
    };

    const UnitModule = Module("UnitFixtureUnit")({
      // The fork seam: `Parent` comes from the application scope this unit
      // module is forked from, never from inside it.
      needs: [Parent],
      provides: [
        Provider(Span)({
          inject: { parent: Parent },
          sync: () => {
            counts.spanBuilds += 1;
            seen.build = currentUnit()?.unitId;
            return { openedIn: seen.build };
          },
          onStop: () => {
            counts.spanStops += 1;
            seen.stop = currentUnit()?.unitId;
            outcomes.push(unitOutcome());
            return teardown();
          },
        }),
      ],
      exports: [Span],
    });

    const BrokenModule = Module("UnitFixtureBroken")({
      provides: [
        Provider(Span)({
          inject: {},
          sync: () => {
            // oxlint-disable-next-line unthrown/no-throw -- the subject under test: a fork's construction failure must reach the caller's defect path
            throw new Error("construction-boom");
          },
        }),
      ],
      exports: [Span],
    });

    const runtime = testRuntime("unit", { unit: UnitModule });
    const AppModule = Module("UnitFixtureApp")({
      imports: [runtime.module],
      provides: [
        Provider(Parent)({
          inject: {},
          sync: () => {
            counts.parentBuilds += 1;
            return { mark: () => {} };
          },
        }),
      ],
      exports: [Parent, TestRuntimePort],
    });

    const app = start(AppModule, {
      signals: false,
      probes: false,
      preDrainDelayMs: 0,
      onEvent: (event) => {
        events.push(event);
      },
    });
    await runtime.untilStarted();

    const forkTwice = (): AsyncResult<unknown, never> =>
      runtime
        .host()
        .run({ kind: "test", id: "twice" }, (unit) =>
          unit.fork(UnitModule as never, []).flatMap(() => unit.fork(UnitModule as never, [])),
        );

    const forkBroken = (): AsyncResult<unknown, never> =>
      runtime
        .host()
        .run({ kind: "test", id: "broken" }, (unit) => unit.fork(BrokenModule as never, []));

    // The work callback returns before ever forking — captured for the
    // caller to invoke once the unit this `.run()` call settles, which is
    // exactly the shape a fork racing a client's abort against its own
    // answerer produces.
    const forkAfterSettled = (): AsyncResult<unknown, never> => {
      let lateFork: (() => AsyncResult<unknown, never>) | undefined;
      const settled = runtime.host().run({ kind: "test", id: "after-settled" }, (unit) => {
        lateFork = () => unit.fork(UnitModule as never, []);
        return OkAsync("done");
      });
      return settled.flatMap(() => (lateFork as () => AsyncResult<unknown, never>)());
    };

    await use({
      runtime,
      app,
      counts,
      seen,
      outcomes,
      events,
      holdTeardown,
      failTeardown,
      forkTwice,
      forkBroken,
      forkAfterSettled,
    });

    app.stop();
    await expect(app.exited).toBeOk();
  },
});
