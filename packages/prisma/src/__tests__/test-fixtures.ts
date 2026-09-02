import type { Attributes, LoggerService, Operation, Settle } from "@btravstack/core";
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
  readonly $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  /** Makes the next `$queryRaw` reject, so the health check can be driven down. */
  readonly breakQueries: (reason: string) => void;
  readonly $extends: (extension: unknown) => StubClient;
  readonly disconnected: () => number;
  readonly url: string;
  /** Drives whatever `query` extension was applied, as Prisma would on a real call. */
  readonly query: (model: string, operation: string, answer: Promise<unknown>) => Promise<unknown>;
};

/** One observed operation, as an observer saw it settle. */
export type Observation = {
  readonly component: string;
  readonly name: string;
  readonly attributes: Attributes;
  readonly outcome: "ok" | "error";
  readonly failed: boolean;
  readonly traced: boolean;
};

export type Logs = {
  readonly logger: LoggerService;
  /** Every `debug` message written — the one level `loadPrismaInstrumentation` uses. */
  readonly debug: () => readonly string[];
};

export type Observed = {
  /** The set a spec hands `instrument` and `loadPrismaInstrumentation`. */
  readonly members: readonly ((operation: Operation) => Settle)[];
  readonly taken: () => readonly Observation[];
};

/**
 * A stand-in for a generated Prisma client that captures the `query` extension
 * this package applies, so a spec can drive it the way Prisma would. The
 * starter owns the pool's lifetime and the wrapper; a real client would be
 * testing Prisma.
 */
export const it = test.extend<{ stub: Stub; observed: Observed; logs: Logs }>({
  stub: async ({}, use) => {
    let last: StubClient | undefined;
    let count = 0;
    const make = (url: string): StubClient => {
      let hook: AllOperations | undefined;
      let queryFailure: string | undefined;
      const client: StubClient = {
        $queryRaw: () =>
          queryFailure === undefined
            ? Promise.resolve([{ "?column?": 1 }])
            : Promise.reject(new Error(queryFailure)),
        breakQueries: (reason: string) => {
          queryFailure = reason;
        },
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

  // oxlint-disable-next-line no-empty-pattern -- see above
  logs: async ({}, use) => {
    const debug: string[] = [];
    const logger = {
      log: () => {},
      trace: () => {},
      debug: (message: string) => debug.push(message),
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      with: () => logger,
      isEnabled: () => true,
    } as unknown as LoggerService;
    await use({ logger, debug: () => debug });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  observed: async ({}, use) => {
    const taken: Observation[] = [];
    await use({
      members: [
        ({ component, name, attributes, details, traced }) =>
          ({ outcome, attributes: settled, cause }) => {
            taken.push({
              component,
              name,
              attributes: { ...attributes, ...details, ...settled },
              outcome,
              failed: cause !== undefined,
              traced: traced !== false,
            });
          },
      ],
      taken: () => taken,
    });
  },
});

export type Stub = {
  readonly client: (connectionString: string) => StubClient;
  readonly last: () => StubClient | undefined;
};
