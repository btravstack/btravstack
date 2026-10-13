import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Env, type ConfigInvalid } from "@btravstack/config";
import {
  HealthChecks,
  Observers,
  type RunningApp,
  type StartOptions,
  type Attributes,
  type Operation,
  type Settle,
} from "@btravstack/core";
import { Module, Provider, type Context } from "@btravstack/di";
import { bootFixture, createFakeClock, type Boot, type FakeClock } from "@btravstack/testing";
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
import { outbox, outboxRuntime, OutboxRuntime, type OutboxOptions } from "../relay.js";

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
  /** Each tenant's oldest pending time, answered to a read pinned to that tenant. */
  readonly oldest?: Readonly<Record<string, string>>;
  /** How many rows a prune answers it deleted. */
  readonly deleted?: number;
  readonly failure?: unknown;
}) => StubDatabase;

export type OutboxFixtures = {
  readonly shutdownProcess: { readonly output: () => string; readonly drain: () => void };
  readonly boot: Boot;
  readonly releases: string[];
  readonly launch: (options?: Omit<StartOptions, "signals" | "env">) => RunningApp<ConfigInvalid>;
  readonly clock: FakeClock;
  readonly store: MemoryOutboxStore;
  readonly observations: Observation[];
  readonly publisher: Publisher;
  readonly relaying: Relaying;
  readonly standalone: <T, E>(
    body: (
      runtime: import("@btravstack/core").Runtime,
      ctx: Context<OutboxRuntime | HealthChecks>,
      host: import("@btravstack/core").RuntimeHost<never>,
    ) => AsyncResult<T, E>,
    options?: OutboxOptions,
  ) => AsyncResult<T, E | ConfigInvalid>;
  readonly stub: Stub;
};

export const it = test.extend<OutboxFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- an independent Vitest fixture
  shutdownProcess: async ({}, use) => {
    const script = `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.includes("/packages/outbox/src/")) specifier = specifier.slice(0, -3) + ".ts";
        return next(specifier, context);
      }});
      const { outboxRuntime, OutboxRuntime } = await import(${JSON.stringify(new URL("../relay.ts", import.meta.url).href)});
      const { OutboxStore, OutboxPublisher } = await import(${JSON.stringify(new URL("../outbox.ts", import.meta.url).href)});
      const { memoryOutboxStore } = await import(${JSON.stringify(new URL("../memory.ts", import.meta.url).href)});
      const { Module, Provider } = await import("@btravstack/di");
      const { runMain } = await import("@btravstack/core");
      const { fromSafePromise, OkAsync } = await import("unthrown");
      const store = memoryOutboxStore();
      store.append({ tenantId: "acme", kind: "order", subjectId: "a", payload: "{}" });
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      const root = Module("ShutdownProcess")({
        imports: [outboxRuntime({ tenants: ["acme"] })],
        provides: [
          Provider(OutboxStore)({ inject: {}, acquire: () => OkAsync(store), release: () => console.log("store released") }),
          Provider(OutboxPublisher)({ inject: {}, value: { publish: () => fromSafePromise(pending) } }),
        ],
        exports: [OutboxRuntime],
      });
      await runMain(root, { probes: false, preDrainDelayMs: 0, drainTimeoutMs: 10, stopTimeoutMs: 10 });
      console.log("shutdown reported");
      release();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    await use({
      output: () => output,
      drain: () => {
        child.kill("SIGTERM");
      },
    });
    child.kill("SIGKILL");
    await exited;
  },
  boot: bootFixture(),
  // oxlint-disable-next-line no-empty-pattern -- an independent Vitest fixture
  releases: async ({}, use) => {
    await use([]);
  },
  launch: async ({ boot, clock, store, publisher, releases }, use) => {
    const root = Module("StandaloneProcess")({
      imports: [outboxRuntime({ tenants: ["acme"], clock })],
      provides: [
        Provider(OutboxStore)({
          inject: {},
          acquire: () => OkAsync(store),
          release: () => {
            releases.push("store");
          },
        }),
        Provider(OutboxPublisher)({
          inject: { store: OutboxStore },
          acquire: () => OkAsync(publisher),
          release: () => {
            releases.push("publisher");
          },
        }),
      ],
      exports: [OutboxRuntime, HealthChecks],
    });
    await use((options = {}) => boot(root, { clock, ...options }));
  },
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

  standalone: async ({ clock, store, publisher }, use) => {
    await use((body, options = {}) =>
      Module.scoped(
        Module("Standalone")({
          imports: [outboxRuntime({ tenants: ["acme"], clock, ...options })],
          provides: [
            Provider(Env)({ inject: {}, value: {} }),
            Provider(OutboxStore)({ inject: {}, value: store }),
            Provider(OutboxPublisher)({ inject: {}, value: publisher }),
          ],
          exports: [OutboxRuntime, HealthChecks],
        }),
        (ctx) =>
          body(ctx.get(OutboxRuntime), ctx, {
            ctx,
            run: (_meta, work) =>
              fromSafePromise(
                Promise.resolve(
                  work(
                    {
                      ctx,
                      fork: () => {
                        // oxlint-disable-next-line unthrown/no-throw -- the relay never forks; reaching this is fixture misuse
                        throw new Error("the relay cannot fork in this fixture");
                      },
                    },
                    new AbortController().signal,
                  ),
                ),
              ).flatMap((result) => result),
          }),
      ),
    );
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
    await use(({ locked = true, rows = [], oldest = {}, deleted = 0, failure }) => {
      const ran: Ran[] = [];
      let transactions = 0;
      let pinned: unknown;
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
              if (sql.startsWith("SELECT set_config(?")) pinned = values[1];
              return Promise.resolve(
                sql.includes("pg_try_advisory_xact_lock")
                  ? [{ locked: String(locked) }]
                  : sql.startsWith("WITH gone")
                    ? [{ deleted: String(deleted) }]
                    : sql.includes("min(")
                      ? [{ occurredAt: oldest[String(pinned)] ?? null }]
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
