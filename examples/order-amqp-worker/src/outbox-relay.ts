import { TypedAmqpClient } from "@amqp-contract/client";
import type { Context } from "@btravstack/di";
import type { OrderContract } from "@btravstack/start-example-order-amqp-contract";
import { Logger, Outbox } from "@btravstack/start-example-order-application";
import { P, fromSafePromise, type AsyncResult } from "unthrown";

/** The ports the relay resolves out of the application context. */
export type RelayNeeds = typeof Outbox | typeof Logger;

export type RelayOptions = {
  /** The broker URLs the relay's own client connects to. */
  readonly urls: readonly string[];
  /** How long to sleep when a sweep finds the outbox empty. */
  readonly pollMs: number;
};

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
 */
export const startOutboxRelay = (
  ctx: Context<InstanceType<RelayNeeds>>,
  contract: OrderContract,
  { urls, pollMs }: RelayOptions,
): AsyncResult<{ readonly stop: () => AsyncResult<void, never> }, never> =>
  TypedAmqpClient.create({ contract, urls: [...urls] }).map((client) => {
    const outbox = ctx.get(Outbox);
    const logger = ctx.get(Logger);

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
              .publish("orderPlaced", { orderId: event.orderId, quantity: event.quantity })
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
