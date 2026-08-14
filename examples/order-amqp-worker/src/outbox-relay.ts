import { TypedAmqpClient } from "@amqp-contract/client";
import { Config } from "@btravstack/config";
import { wholeNumber } from "@btravstack/config/zod";
import type { Context } from "@btravstack/di";
import { orderContract } from "@btravstack/start-example-order-amqp-contract";
import { Logger, Outbox } from "@btravstack/start-example-order-application";
import { P, fromSafePromise, type AsyncResult } from "unthrown";

import { amqpConfig } from "./config.js";

/**
 * The relay's own knob, declared next to the loop it tunes rather than in a
 * central file every consumer has to know about: the shape, the bound and the
 * default live with the code that gives them meaning.
 *
 * The identity and the prefix differ on purpose — the thing is the outbox
 * relay, the variable an operator sets is `OUTBOX_POLL_MS`, and
 * `options.prefix` is what lets both stay true at once.
 */
export const outboxRelayConfig = Config("OutboxRelay")(
  { pollMs: wholeNumber(200, 1, 60_000) },
  { prefix: "OUTBOX" },
);

/**
 * The ports the relay resolves out of the application context: the two
 * application services, and the two configs that tune it. Configuration
 * arrives the same way `Outbox` does — through di — rather than threaded down
 * from `main.ts` as constructor arguments.
 */
export type RelayNeeds =
  | typeof Outbox
  | typeof Logger
  | typeof amqpConfig
  | typeof outboxRelayConfig;

/** How many outbox rows one sweep publishes before sleeping. */
const BATCH = 32;

/**
 * The other half of the outbox pattern: `OrderRepository.save` wrote the fact
 * down, this loop says it out loud. Pull what is pending, publish it to the
 * `orders` exchange, mark it sent — in commit order, forever, until told to
 * stop.
 *
 * The loop is deliberately at-least-once. A crash between publish and
 * `markPublished` re-publishes on the next sweep; a broker outage leaves rows
 * pending and the sweep after the outage drains them. What is *never* possible
 * is the inverse failure — an order committed whose event evaporated — because
 * the event was committed by the same transaction as the order.
 *
 * Failure triage per event, all three channels: published → mark; a
 * validation error → the row cannot ever serialize, a bug worth a log line,
 * left pending so it stays visible; a defect (broker down, mid-flight close)
 * → logged, left pending, retried next sweep.
 *
 * **Why the client is created here rather than injected as a port, and why
 * this is not a di provider.** A transport connection is a *runtime* concern
 * in this repo: `start-amqp` creates its own `TypedAmqpWorker` inside
 * `Runtime.start` from the same URL, and `order-temporal-worker`'s `main.ts`
 * opens its `NativeConnection` itself. Only `OrderDatabase` is a resourceful
 * provider, because the *application* depends on it — the repository cannot be
 * built without one. Nothing in the application graph depends on this
 * publisher, and a provider exists to be resolved by someone.
 *
 * The *address* it connects to is a different question, and the answer is di:
 * `ctx.get(amqpConfig)` reads the same value the consumer half reads, so the
 * two halves cannot be pointed at different brokers by a threading mistake in
 * `main.ts`.
 *
 * It is not a second connection, either: `@amqp-contract/core`'s
 * `ConnectionManagerSingleton` pools by URL and reference-counts leases, so
 * this client and the consumer's worker share one TCP connection and
 * `client.close()` releases a lease rather than closing the socket.
 */
export const startOutboxRelay = (
  ctx: Context<InstanceType<RelayNeeds>>,
): AsyncResult<{ readonly stop: () => AsyncResult<void, never> }, never> =>
  TypedAmqpClient.create({
    contract: orderContract,
    urls: [ctx.get(amqpConfig).url],
  }).map((client) => {
    const outbox = ctx.get(Outbox);
    const logger = ctx.get(Logger);
    const { pollMs } = ctx.get(outboxRelayConfig);

    let stopped = false;
    let wake: (() => void) | undefined;
    const sleep = (): Promise<void> =>
      new Promise((resolve) => {
        // The timer is cleared on an early wake and `unref`ed besides: a
        // stray timeout would keep the event loop alive past `stop()` for up
        // to `pollMs`, and an idle relay must not pin the process on its own.
        const timer = setTimeout(resolve, pollMs);
        timer.unref();
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });

    const sweep = async (): Promise<void> => {
      await outbox.pending(BATCH).match({
        ok: async (events) => {
          const published: number[] = [];
          for (const event of events) {
            await client
              .publish("orderChanged", {
                kind: event.kind,
                id: event.subjectId,
                occurredAt: event.occurredAt.toISOString(),
                payload: event.payload,
              })
              .match({
                ok: () => {
                  published.push(event.id);
                },
                errCases: (matcher) =>
                  matcher.with(P.tag("@amqp-contract/MessageValidationError"), () => {
                    logger.info(`outbox event ${event.id} does not fit the contract; left pending`);
                  }),
                defect: (cause) => {
                  logger.info(
                    `publishing outbox event ${event.id} failed, will retry: ${String(cause)}`,
                  );
                },
              });
          }
          if (published.length > 0) {
            await outbox.markPublished(published).match({
              ok: () => {},
              // `E = never`: the untouched builder is already exhaustive.
              errCases: (matcher) => matcher,
              defect: (cause) => {
                logger.info(`marking outbox events published failed: ${String(cause)}`);
              },
            });
          }
        },
        errCases: (matcher) => matcher,
        defect: (cause) => {
          logger.info(`reading the outbox failed, will retry: ${String(cause)}`);
        },
      });
    };

    const running = (async () => {
      while (!stopped) {
        await sweep();
        if (!stopped) await sleep();
      }
    })();

    return {
      stop: () =>
        fromSafePromise(
          (async () => {
            stopped = true;
            wake?.();
            await running;
          })(),
        ).flatMap(() => client.close()),
    };
  });
