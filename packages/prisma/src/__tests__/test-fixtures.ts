import type { Attributes, Operation, Settle } from "@btravstack/core";
import { test } from "vitest";

import type { SqlMiddlewareLike } from "../instrument.js";

/** One statement the stub was asked to run, as the raw lane built it. */
export type Plan = {
  readonly sql: string;
  readonly values: readonly unknown[];
  /** Which terminal built it — `execute` takes the first, `query` the second. */
  readonly kind: "affectedCount" | "row";
  /** The transaction it ran in, or `undefined` for one run on the client. */
  readonly tx: number | undefined;
};

/** What a transaction callback is handed: somewhere to run a plan. */
export type StubTx = { readonly query: (plan: unknown) => Promise<unknown> };

export type StubClient = {
  readonly raw: {
    readonly sql: (
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ) => {
      readonly affectedCount: () => { readonly build: () => unknown };
      readonly returnsRow: (spec: Readonly<Record<string, string>>) => {
        readonly build: () => unknown;
      };
    };
  };
  readonly runtime: () => {
    readonly execute: (plan: unknown) => Promise<unknown>;
    readonly query: (plan: unknown) => Promise<unknown>;
    readonly close: () => Promise<void>;
  };
  readonly transaction: <R>(fn: (tx: StubTx) => PromiseLike<R>) => Promise<R>;
  /** Makes every statement reject, so the health check can be driven down. */
  readonly breakQueries: (reason: string) => void;
  /**
   * The same, with whatever the driver felt like rejecting. A driver is not
   * obliged to reject with an `Error`, and the health check has an arm for it.
   */
  readonly breakQueriesWith: (cause: unknown) => void;
  /** What the starter bound: the URL it read, and the middleware it passed. */
  readonly url: string;
  readonly middleware: readonly SqlMiddlewareLike[];
  /** How many times the pool was closed, over every client this factory made. */
  readonly closed: () => number;
  /** Every plan run, in order — the order the pin depends on. */
  readonly ran: () => readonly Plan[];
};

/**
 * One observed operation, as an observer saw it settle.
 *
 * `attributes` and `details` are kept APART rather than merged, which is what
 * makes the bounded/unbounded split assertable: an attribute rides the
 * instruments, so a spec that flattened the two could not catch a row count
 * minting a time series per value.
 */
export type Observation = {
  readonly component: string;
  readonly name: string;
  readonly attributes: Attributes;
  readonly details: Attributes;
  readonly outcome: "ok" | "error";
  readonly failed: boolean;
  readonly traced: boolean;
};

export type Observed = {
  /** The set a spec hands `queryObserver`. */
  readonly members: readonly ((operation: Operation) => Settle)[];
  readonly taken: () => readonly Observation[];
};

/** A Prisma 8 `SqlQueryError`, as the qualifier reads one. */
export type SqlErrorOf = (
  sqlState: string,
  extra?: Readonly<Record<string, string>>,
) => Error & { readonly sqlState: string };

export type Stub = {
  readonly client: (binding: {
    readonly url: string;
    readonly middleware: readonly SqlMiddlewareLike[];
  }) => StubClient;
  readonly last: () => StubClient | undefined;
};

/**
 * A stand-in for a Prisma 8 client: it records what the starter bound, what
 * statements ran and in which transaction. The starter owns the pool's lifetime
 * and the middleware it passes; a real client would be testing Prisma.
 */
export const it = test.extend<{ stub: Stub; observed: Observed; sqlError: SqlErrorOf }>({
  // oxlint-disable-next-line no-empty-pattern -- see below
  sqlError: async ({}, use) => {
    await use((sqlState, extra) =>
      Object.assign(new Error(`refused: ${sqlState}`), { sqlState, ...extra }),
    );
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  stub: async ({}, use) => {
    let last: StubClient | undefined;
    let closed = 0;

    const make = (binding: {
      readonly url: string;
      readonly middleware: readonly SqlMiddlewareLike[];
    }): StubClient => {
      let failure: { readonly cause: unknown } | undefined;
      let transactions = 0;
      const ran: Plan[] = [];

      // The plan a terminal builds carries its own text; running it is what
      // appends to `ran`, so a plan built and never run is invisible — which is
      // what makes "the pin ran FIRST, inside the transaction" assertable.
      const planOf = (
        strings: TemplateStringsArray,
        values: readonly unknown[],
        kind: Plan["kind"],
      ): Plan => ({ sql: strings.join("?"), values, kind, tx: undefined });

      const run = (plan: unknown, tx: number | undefined): Promise<unknown> => {
        ran.push({ ...(plan as Plan), tx });
        return failure === undefined
          ? Promise.resolve([{ pinned: "ok" }])
          : Promise.reject(failure.cause);
      };

      const client: StubClient = {
        raw: {
          sql: (strings, ...values) => ({
            affectedCount: () => ({ build: () => planOf(strings, values, "affectedCount") }),
            returnsRow: () => ({ build: () => planOf(strings, values, "row") }),
          }),
        },
        runtime: () => ({
          execute: (plan) => run(plan, undefined),
          query: (plan) => run(plan, undefined),
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        }),
        transaction: async (fn) => {
          transactions += 1;
          const id = transactions;
          return fn({ query: (plan) => run(plan, id) });
        },
        breakQueries: (reason) => {
          failure = { cause: new Error(reason) };
        },
        breakQueriesWith: (cause) => {
          failure = { cause };
        },
        url: binding.url,
        middleware: binding.middleware,
        closed: () => closed,
        ran: () => ran,
      };
      last = client;
      return client;
    };

    await use({ client: make, last: () => last });
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
              attributes: { ...attributes, ...settled },
              details: { ...details },
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
