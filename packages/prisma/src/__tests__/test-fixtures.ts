import type {
  Attributes,
  Counter,
  LoggerService,
  MeterService,
  TracerService,
} from "@btravstack/core";
import { test } from "vitest";

/** What a `query` extension hands `$allOperations`, as this package uses it. */
type AllOperations = (args: {
  readonly model: string | undefined;
  readonly operation: string;
  readonly args: unknown;
  readonly query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

export type StubClient = {
  readonly $disconnect: () => Promise<void>;
  readonly $extends: (extension: unknown) => StubClient;
  readonly disconnected: () => number;
  readonly url: string;
  /** Drives whatever `query` extension was applied, as Prisma would on a real call. */
  readonly query: (model: string, operation: string, answer: Promise<unknown>) => Promise<unknown>;
};

export type Recorded = {
  readonly spans: readonly { name: string; attributes: Attributes; failed: boolean }[];
  readonly counts: readonly { value: number; attributes: Attributes }[];
  readonly errors: readonly { message: string; attributes: Attributes }[];
  readonly debug: readonly { message: string }[];
};

export type Telemetry = {
  readonly logger: LoggerService;
  readonly tracer: TracerService;
  readonly meter: MeterService;
  readonly recorded: () => Recorded;
};

const noop = (): void => {};

/**
 * A stand-in for a generated Prisma client that captures the `query` extension
 * this package applies, so a spec can drive it the way Prisma would. The
 * starter owns the pool's lifetime and the wrapper; a real client would be
 * testing Prisma.
 */
export const it = test.extend<{ stub: Stub; telemetry: Telemetry }>({
  stub: async ({}, use) => {
    let last: StubClient | undefined;
    let count = 0;
    const make = (url: string): StubClient => {
      let hook: AllOperations | undefined;
      const client: StubClient = {
        $disconnect: () => {
          count += 1;
          return Promise.resolve();
        },
        $extends: (extension) => {
          const ext = extension as {
            readonly query?: { readonly $allModels?: { readonly $allOperations?: AllOperations } };
          };
          hook = ext.query?.$allModels?.$allOperations;
          return client;
        },
        disconnected: () => count,
        url,
        query: (model, operation, answer) =>
          hook === undefined ? answer : hook({ model, operation, args: {}, query: () => answer }),
      };
      last = client;
      return client;
    };
    await use({ client: make, last: () => last });
  },

  telemetry: async ({}, use) => {
    const spans: { name: string; attributes: Attributes; failed: boolean }[] = [];
    const counts: { value: number; attributes: Attributes }[] = [];
    const errors: { message: string; attributes: Attributes }[] = [];
    const debug: { message: string }[] = [];

    const counter: Counter = {
      add: (value, attributes) => counts.push({ value, attributes: attributes ?? {} }),
    };

    await use({
      logger: {
        trace: noop,
        debug: (message: string) => debug.push({ message }),
        info: noop,
        warn: noop,
        error: (message: string, attributes?: Attributes) =>
          errors.push({ message, attributes: attributes ?? {} }),
        fatal: noop,
      } as unknown as LoggerService,
      tracer: {
        startSpan: (name: string) => {
          const span = { name, attributes: {} as Attributes, failed: false };
          spans.push(span);
          return {
            setAttributes: (attributes: Attributes) => {
              span.attributes = { ...span.attributes, ...attributes };
            },
            setStatus: () => {
              span.failed = true;
            },
            end: noop,
          };
        },
      } as unknown as TracerService,
      meter: { createCounter: () => counter } as unknown as MeterService,
      recorded: () => ({ spans, counts, errors, debug }),
    });
  },
});

export type Stub = {
  readonly client: (connectionString: string) => StubClient;
  readonly last: () => StubClient | undefined;
};
