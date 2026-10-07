import { setTimeout as delay } from "node:timers/promises";

import { Env, type ConfigInvalid } from "@btravstack/config";
import {
  HealthChecks,
  Observers,
  type Attributes,
  type Operation,
  type Settle,
} from "@btravstack/core";
import { Module, Provider, type Context } from "@btravstack/di";
import { createFakeClock, type FakeClock } from "@btravstack/testing";
import { ErrAsync, OkAsync, TaggedError, fromSafePromise, type AsyncResult } from "unthrown";
import { test } from "vitest";

import { memoryOutboxStore, type MemoryOutboxStore } from "../memory.js";
import {
  OutboxPublisher,
  OutboxStore,
  type OutboxMessage,
  type OutboxPublisherService,
  type OutboxStoreService,
} from "../outbox.js";
import { outbox, type OutboxOptions } from "../relay.js";

class Refused extends TaggedError("Refused") {}

/** One observed operation, as an observer saw it settle. */
export type Observation = {
  readonly component: string;
  readonly name: string;
  readonly attributes: Attributes;
  readonly details: Attributes;
  readonly outcome: "ok" | "error";
  readonly traced: boolean;
};

/** A publisher that records what it was handed, and refuses what a test tells it to. */
export type Publisher = OutboxPublisherService & {
  readonly sent: () => readonly string[];
  /** Refuse `subjectId`'s message the next `times` attempts (default: forever). */
  readonly refuse: (subjectId: string, times?: number) => void;
  /** Make every publish wait one real macrotask, so two relays overlap. */
  readonly slow: () => void;
  /** Hold one publish until the test releases it. */
  readonly hold: (subjectId: string) => {
    readonly entered: Promise<void>;
    readonly release: () => void;
  };
};

/** A graph around `outbox(options)`, over the fixtures' store, publisher and observers. */
export type Relaying = <T, E>(
  options: OutboxOptions & { readonly env?: Readonly<Record<string, string>> },
  body: (ctx: Context<HealthChecks>) => AsyncResult<T, E>,
  store?: OutboxStoreService,
) => AsyncResult<T, E | ConfigInvalid>;

/** A batch of rows the stub client answers for a `SELECT`, as the raw lane decodes them. */
export type StubRow = Omit<OutboxMessage, "id" | "occurredAt"> & {
  readonly id: bigint;
  readonly occurredAt: string;
};

/** One statement the stub ran. */
export type Ran = {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly tx: number;
};

export type StubDatabase = {
  readonly raw: {
    readonly sql: (
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ) => {
      readonly returnsRow: (spec: Readonly<Record<string, string>>) => {
        readonly build: () => unknown;
      };
      readonly affectedCount: () => { readonly build: () => unknown };
    };
  };
  readonly transaction: <R>(
    fn: (tx: { readonly query: (plan: unknown) => Promise<unknown> }) => PromiseLike<R>,
  ) => Promise<R>;
  readonly ran: () => readonly Ran[];
};

export type Stub = (answers: {
  readonly locked?: boolean;
  readonly rows?: readonly StubRow[];
  readonly failure?: unknown;
}) => StubDatabase;

export type OutboxFixtures = {
  readonly clock: FakeClock;
  readonly store: MemoryOutboxStore;
  readonly observations: Observation[];
  readonly publisher: Publisher;
  readonly relaying: Relaying;
  readonly stub: Stub;
};

export const it = test.extend<OutboxFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  clock: async ({}, use) => {
    await use(createFakeClock(1_000_000));
  },

  store: async ({ clock }, use) => {
    await use(memoryOutboxStore(clock));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  observations: async ({}, use) => {
    await use([]);
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  publisher: async ({}, use) => {
    const sent: string[] = [];
    const refusals = new Map<string, number>();
    const holds = new Map<string, { readonly enter: () => void; readonly resume: Promise<void> }>();
    let slow = false;
    await use({
      publish: (message) =>
        fromSafePromise(
          (async () => {
            if (slow) await delay(1);
            const hold = holds.get(message.subjectId);
            if (hold) {
              hold.enter();
              await hold.resume;
            }
            const left = refusals.get(message.subjectId) ?? 0;
            if (left > 0) {
              refusals.set(message.subjectId, left - 1);
              return false;
            }
            sent.push(message.subjectId);
            return true;
          })(),
        ).flatMap((accepted) => (accepted ? OkAsync() : ErrAsync(new Refused()))),
      sent: () => sent,
      refuse: (subjectId, times = Number.POSITIVE_INFINITY) => {
        refusals.set(subjectId, times);
      },
      slow: () => {
        slow = true;
      },
      hold: (subjectId) => {
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const resume = new Promise<void>((resolve) => {
          release = resolve;
        });
        holds.set(subjectId, { enter, resume });
        return { entered, release };
      },
    });
  },

  relaying: async ({ clock, store, observations, publisher }, use) => {
    const recorder =
      ({ component, name, attributes, details, traced }: Operation): Settle =>
      ({ outcome, attributes: settled }) => {
        observations.push({
          component,
          name,
          attributes: { ...attributes, ...settled },
          details: { ...details },
          outcome,
          traced: traced !== false,
        });
      };
    await use(({ env = {}, ...options }, body, over = store) =>
      Module.scoped(
        Module("Relaying")({
          imports: [outbox({ clock, ...options })],
          provides: [
            Provider(Env)({ inject: {}, value: env }),
            Provider(OutboxStore)({ inject: {}, value: over }),
            Provider(OutboxPublisher)({ inject: {}, value: publisher }),
            Provider.member(Observers)({ inject: {}, value: recorder }),
          ],
          exports: [HealthChecks],
        }),
        body,
      ),
    );
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  stub: async ({}, use) => {
    await use(({ locked = true, rows = [], failure }) => {
      const ran: Ran[] = [];
      let transactions = 0;
      type Plan = { readonly sql: string; readonly values: readonly unknown[] };
      const plan = (strings: TemplateStringsArray, values: readonly unknown[]) => ({
        build: (): Plan => ({ sql: strings.join("?"), values }),
      });
      return {
        raw: {
          sql: (strings, ...values) => ({
            returnsRow: () => plan(strings, values),
            affectedCount: () => plan(strings, values),
          }),
        },
        transaction: async (fn) => {
          if (failure !== undefined) return Promise.reject(failure);
          transactions += 1;
          const tx = transactions;
          return fn({
            query: (built) => {
              const { sql, values } = built as Plan;
              ran.push({ sql, values, tx });
              return Promise.resolve(
                sql.includes("pg_try_advisory_xact_lock")
                  ? [{ locked: String(locked) }]
                  : sql.startsWith("SELECT")
                    ? rows
                    : { affectedRows: 0 },
              );
            },
          });
        },
        ran: () => ran,
      };
    });
  },
});
