import { RuntimePort, type Runtime } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { bootFixture, testRuntime, TestRuntimePort, type Boot } from "@btravstack/testing";
import { Ok, OkAsync } from "unthrown";
import { test } from "vitest";

import { Logger, createLogger, type Level, type Line, type LoggerService } from "./logger.js";
import { LoggerConfig, observability, type ObservabilityOptions } from "./observability.js";

/** A sink that keeps what it was given, so a spec asserts on the line rather than on a stream. */
export type Recorder = {
  readonly sink: (line: Line) => void;
  readonly lines: () => readonly Line[];
  /** The one line written, asserted here so a test body cannot pass on an empty capture. */
  readonly only: () => Line;
};

const recorderOf = (): Recorder => {
  const lines: Line[] = [];
  return {
    sink: (line) => lines.push(line),
    lines: () => lines,
    only: () => {
      const [first] = lines;
      if (first === undefined || lines.length !== 1) {
        // oxlint-disable-next-line unthrown/no-throw -- a fixture read before the line it exists to capture is a broken test, and the loudest possible answer is the right one
        throw new Error(`expected exactly one line, got ${lines.length}`);
      }
      return first;
    },
  };
};

/** A stream that keeps what was written to it, for the sinks that write text. */
export type Written = {
  readonly write: (chunk: string) => void;
  readonly chunks: () => readonly string[];
};

const writtenOf = (): Written => {
  const chunks: string[] = [];
  return { write: (chunk) => chunks.push(chunk), chunks: () => chunks };
};

/** A service the spec resolves out of a booted graph, so the logger under test is the graph's own. */
export class Greeting extends Port("ObservabilityFixtureGreeting")<{ readonly text: string }> {}

/** A port a unit module provides, so a spec has code that genuinely runs inside the kernel's ambient record. */
export class UnitSpan extends Port("ObservabilityFixtureUnitSpan")<{ readonly opened: true }> {}

/**
 * A runtime that opens one unit **with a tenant** and logs inside it.
 *
 * No shipped runtime sets `UnitMeta.tenantId` — it is there for a
 * multi-tenant deployment to supply — so a hand-rolled one is the only way to
 * prove the logger carries it, and it doubles as the smallest example of a
 * runtime declaring what it `resolves`.
 */
class TenantRuntime extends RuntimePort<Runtime<typeof Logger>> {}

const tenantRuntimeModule = (tenantId: string) =>
  Module("TenantRuntime")({
    provides: [
      Provider(TenantRuntime)({
        value: {
          name: "tenant",
          resolves: [Logger],
          start: (host) => {
            void host.run({ kind: "tenanted", id: "unit-1", tenantId }, (ctx) => {
              ctx.get(Logger).info("inside a tenant's unit");
              return Ok(undefined);
            });
            return OkAsync({ drain: () => OkAsync(), stop: () => OkAsync() });
          },
        },
      }),
    ],
    exports: [TenantRuntime],
  });

export type ObservabilityFixtures = {
  readonly boot: Boot;
  readonly recorder: Recorder;
  readonly written: Written;
  /** A logger over `recorder`, at `level` — the unit-level subject. */
  readonly loggerAt: (level?: Level) => LoggerService;
  /**
   * The starter as an application composes it, next to an in-memory runtime,
   * plus the runtime itself so a spec can hold a unit open and log inside it.
   */
  /** A `StartOptions.unit` module that logs as it is built — inside the unit, through the application's own `Logger`. */
  readonly unitLogging: Module<UnitSpan, never, Logger>;
  /** An application whose runtime opens one unit carrying a tenant, and logs inside it. */
  readonly tenantApp: (
    tenantId: string,
    options?: ObservabilityOptions,
  ) => Module<Logger | TenantRuntime, never, never>;
  readonly app: (options?: ObservabilityOptions) => {
    readonly module: Module<Logger | LoggerConfig | Greeting | TestRuntimePort, never, never>;
    readonly runtime: ReturnType<typeof testRuntime>;
  };
};

export const it = test.extend<ObservabilityFixtures>({
  boot: bootFixture(),

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  recorder: async ({}, use) => {
    await use(recorderOf());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  written: async ({}, use) => {
    await use(writtenOf());
  },

  loggerAt: async ({ recorder }, use) => {
    await use((level) => createLogger(recorder.sink, level));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  unitLogging: async ({}, use) => {
    await use(
      Module("UnitLogging")({
        needs: [Logger],
        provides: [
          Provider(UnitSpan)(
            { logger: Logger },
            {
              sync: ({ logger }) => {
                logger.info("inside the unit");
                return { opened: true };
              },
            },
          ),
        ],
        exports: [UnitSpan],
      }),
    );
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  tenantApp: async ({}, use) => {
    await use(
      (tenantId, options = {}) =>
        Module("TenantApp")({
          imports: [tenantRuntimeModule(tenantId), observability(options)],
          exports: [Logger, TenantRuntime],
        }) as unknown as Module<Logger | TenantRuntime, never, never>,
    );
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  app: async ({}, use) => {
    await use((options = {}) => {
      const runtime = testRuntime();
      return {
        runtime,
        module: Module("ObservabilityApp")({
          imports: [runtime.module, observability(options)],
          provides: [Provider(Greeting)({ value: { text: "hello" } })],
          exports: [Logger, LoggerConfig, Greeting, TestRuntimePort],
          // The starter's own `ConfigInvalid` and `Env` are discharged by the
          // kernel and asserted by the spec that boots a bad `LOG_LEVEL`;
          // spelling them here would put them in every fixture's signature.
        }) as unknown as Module<Logger | LoggerConfig | Greeting | TestRuntimePort, never, never>,
      };
    });
  },
});
