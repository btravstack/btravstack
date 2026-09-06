import type { Attributes, LoggerService, Operation, Settle } from "@btravstack/core";
import { test } from "vitest";

/** What a `query` extension hands `$allOperations`, as this package uses it. */
type AllOperations = (args: {
  readonly model: string | undefined;
  readonly operation: string;
  readonly args: unknown;
  readonly query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

/** One statement the stub saw, as `$executeRaw` received it. */
export type Statement = { readonly raw: string; readonly values: readonly unknown[] };

/** One `$transaction` the extension issued through the stub. */
export type Issued =
  | {
      readonly kind: "batch";
      readonly statements: readonly (Statement | { readonly op: string })[];
    }
  | { readonly kind: "interactive"; readonly pinned: Statement | undefined };

export type StubClient = {
  readonly $disconnect: () => Promise<void>;
  readonly $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  readonly $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  readonly $transaction: (arg: unknown, options?: unknown) => Promise<unknown>;
  /** Makes the next `$queryRaw` reject, so the health check can be driven down. */
  readonly breakQueries: (reason: string) => void;
  readonly $extends: (extension: unknown) => StubClient;
  readonly disconnected: () => number;
  readonly url: string;
  /** Drives whatever `$allModels` extension was applied, as Prisma would on a real call. */
  readonly query: (model: string, operation: string, answer: Promise<unknown>) => Promise<unknown>;
  /** Drives whatever top-level `$allOperations` extension was applied. */
  readonly operation: (
    model: string | undefined,
    operation: string,
    answer: Promise<unknown>,
  ) => Promise<unknown>;
  /** How many times that top-level hook has run. */
  readonly operations: () => number;
  /** Calls the `client.$transaction` an extension installed. */
  readonly transaction: (arg: unknown) => Promise<unknown>;
  /** What the stub's batch `$transaction` resolves with. */
  readonly resolveBatchWith: (results: readonly unknown[]) => void;
  /** Every `$transaction` the extension issued through this client. */
  readonly issued: () => readonly Issued[];
};

/** A `$executeRaw` / `query` promise, tagged so the batch can be read back. */
type Tagged = Promise<unknown> & { statement?: Statement; op?: string };

const statementOf = (element: unknown): Statement | { readonly op: string } => {
  const tagged = element as Tagged;
  return tagged.statement ?? { op: tagged.op ?? "untagged" };
};

const tag = <T>(promise: Promise<T>, marks: { statement?: Statement; op?: string }): Promise<T> =>
  Object.assign(promise, marks);

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
      let everyOperation: AllOperations | undefined;
      let override: ((arg: unknown, options?: unknown) => Promise<unknown>) | undefined;
      let queryFailure: string | undefined;
      let batch: readonly unknown[] = [1, undefined];
      let operations = 0;
      const issued: Issued[] = [];
      const client: StubClient = {
        $queryRaw: () =>
          queryFailure === undefined
            ? Promise.resolve([{ "?column?": 1 }])
            : Promise.reject(new Error(queryFailure)),
        $executeRaw: (query, ...values) =>
          tag(Promise.resolve(1), { statement: { raw: query.join("?"), values } }),
        $transaction: (arg) => {
          if (Array.isArray(arg)) {
            issued.push({ kind: "batch", statements: arg.map(statementOf) });
            return Promise.resolve(batch);
          }
          const entry: { kind: "interactive"; pinned: Statement | undefined } = {
            kind: "interactive",
            pinned: undefined,
          };
          issued.push(entry);
          const tx = {
            $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => {
              entry.pinned ??= { raw: query.join("?"), values };
              return Promise.resolve(1);
            },
            $queryRaw: () => Promise.resolve("raw-on-tx"),
          };
          return (arg as (tx: unknown) => Promise<unknown>)(tx);
        },
        breakQueries: (reason: string) => {
          queryFailure = reason;
        },
        $disconnect: () => {
          count += 1;
          return Promise.resolve();
        },
        $extends: (extension) => {
          const ext = extension as {
            readonly query?: {
              readonly $allModels?: { readonly $allOperations?: AllOperations };
              readonly $allOperations?: AllOperations;
            };
            readonly client?: {
              readonly $transaction?: (arg: unknown, options?: unknown) => Promise<unknown>;
            };
          };
          hook = ext.query?.$allModels?.$allOperations;
          everyOperation = ext.query?.$allOperations;
          override = ext.client?.$transaction;
          return client;
        },
        disconnected: () => count,
        url,
        query: (model, operation, answer) =>
          hook === undefined ? answer : hook({ model, operation, args: {}, query: () => answer }),
        operation: (model, operation, answer) => {
          if (everyOperation === undefined) return answer;
          operations += 1;
          return everyOperation({
            model,
            operation,
            args: {},
            query: () => tag(Promise.resolve(answer), { op: operation }),
          });
        },
        operations: () => operations,
        transaction: (arg) =>
          override === undefined
            ? Promise.reject(new Error("no $transaction override was installed"))
            : override.call(client, arg),
        resolveBatchWith: (results) => {
          batch = results;
        },
        issued: () => issued,
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
