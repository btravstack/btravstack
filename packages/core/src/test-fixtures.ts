import { Module, Port, Provider } from "@btravstack/di";
import { expect, test } from "vitest";

import type { KernelEvent } from "./events.js";
import { start, type RunningApp } from "./start.js";
import { testRuntime, type TestRuntime, type TestRuntimeInfo } from "./test-runtime.js";
import { currentUnit } from "./units.js";

class Parent extends Port("UnitFixtureParent")<{ readonly mark: () => void }> {}
class Span extends Port("UnitFixtureSpan")<{ readonly openedIn: string | undefined }> {}

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
export const it = test.extend<{ unitApp: UnitApp }>({
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

    const AppModule = Module("UnitFixtureApp")({
      provides: [
        Provider(Parent)({
          sync: () => {
            counts.parentBuilds += 1;
            return { mark: () => {} };
          },
        }),
      ],
      exports: [Parent],
    });

    const UnitModule = Module("UnitFixtureUnit")({
      provides: [
        Provider(Span)([Parent], {
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
        }),
      ],
      exports: [Span],
    });

    const runtime = testRuntime();
    const app = start(AppModule, {
      runtime,
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
