import { declareHandler, NonRetryableError, RetryableError } from "@amqp-contract/worker";
import {
  amqpRuntime,
  messageUnits,
  type AmqpInfo,
  type MessageUnitContext,
} from "@btravstack/start-amqp";
import type { Runtime } from "@btravstack/start-core";
import type { OrderContract } from "@btravstack/start-example-order-amqp-contract";
import { Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import { ErrAsync, P } from "unthrown";

/**
 * The ports this runtime resolves out of the application context — the same
 * two the queue worker and the Temporal worker need, and for the same reason:
 * `FindOrder` is not part of any delivery this worker consumes, and a runtime
 * declares what *it* needs rather than what the module happens to export.
 *
 * Non-empty on purpose: it is what makes `start`'s arity gate mean something
 * (`src/needs-gate.test-d.ts` pins both directions).
 */
type AmqpNeeds = typeof PlaceOrder | typeof Logger;

/**
 * A `Runtime` serving the order application as an AMQP consumer — and, since
 * `@btravstack/start-amqp` shipped, no longer a hand-rolled one.
 *
 * What is left here is the application's half: the contract, the two ports the
 * handler resolves, and the triage from a domain `Err` to `HandlerError`. The
 * worker's lifecycle, the unit per delivery and the release at the kernel's
 * deadline are the package's, which is the point — the fourth deployment
 * consumes a runtime package exactly as `order-api` consumes
 * `@btravstack/start-http` and `order-temporal` consumes
 * `@btravstack/start-temporal`.
 */
export const orderAmqpRuntime = ({
  contract,
  ...transport
}: {
  /** The contract, and with it the queue this worker consumes. */
  readonly contract: OrderContract;
  /** The broker URLs `TypedAmqpWorker` connects to — it owns the connection. */
  readonly urls: readonly string[];
}): Runtime<AmqpNeeds, AmqpInfo> =>
  amqpRuntime({
    ...transport,
    contract,
    needs: [PlaceOrder, Logger],
    // `placeHandler(contract)` rather than a pre-built constant: `contract` is
    // what every caller passes in (`main.ts`, the needs-gate type test), and
    // building the handler from that parameter — the same way `-temporal`'s
    // `activities` builder threads its own `contract` into
    // `declareActivitiesHandler` — is what makes it load-bearing rather than
    // a decorative pass-through to the module's own top-level `orderContract`.
    handlers: () => ({ placeOrder: placeHandler(contract) }),
    middleware: (host) => messageUnits<AmqpNeeds>(host),
  });

/**
 * The one handler, and the fourth sibling of the same fold. `DuplicateOrder`
 * is a `CONFLICT` over HTTP because a caller is waiting to be told, a
 * dead-letter on the in-memory queue because none is, a typed contract error
 * on Temporal because a workflow is waiting — and here a `NonRetryableError`,
 * which is the broker's vocabulary for the same permanent answer: park it, do
 * not ask again.
 *
 * `NonRetryableError`'s constructor is `(message: string, cause?: unknown)` —
 * a `TaggedError`, not the free-form shape a guess might reach for. `error._tag`
 * is a legible message on its own (`"InvalidQuantity"` / `"DuplicateOrder"`),
 * and passing `error` itself as the cause keeps the original domain error
 * attached for whoever reads the DLQ'd message's logs, the same way the
 * library's own examples pair a message with a cause
 * (`new RetryableError('Payment failed', error)`).
 *
 * Every named case is a compile error to omit. A `Defect` is a THIRD thing,
 * and it is the one place this fold does not repeat itself: Temporal's own
 * activity boundary re-throws a `Defect`'s cause so the platform's *native*
 * retry policy picks it up, and the queue worker's `dispositionOf` explicitly
 * folds `defect` into `retry`. `@amqp-contract/worker`'s own dispatch does
 * neither — measured directly against a real broker, an `AsyncResult` that
 * settles as a `Defect` here is nacked **once**, immediately, under its
 * original routing key, never touching `order-placements`'s `retry` budget at
 * all (`routeHandlerError`'s `handleError` is reached only for a value the
 * matcher above already turned into a `RetryableError` / `NonRetryableError`).
 * So an infrastructure failure has to be turned into a `RetryableError`
 * explicitly, or "infrastructure comes back" would be false on this transport
 * alone.
 */
const placeHandler = (contract: OrderContract) =>
  declareHandler<OrderContract, "placeOrder", MessageUnitContext<AmqpNeeds>>(
    contract,
    "placeOrder",
    (message, _raw, { context }) =>
      context.ctx
        .get(PlaceOrder)
        .execute(message.payload.orderId, message.payload.quantity)
        .map(() => undefined)
        .mapErrCases((matcher) =>
          matcher.with(
            P.tag("InvalidQuantity"),
            P.tag("DuplicateOrder"),
            (error) => new NonRetryableError(error._tag, error),
          ),
        )
        .recoverDefect((cause) => ErrAsync(new RetryableError("placing the order failed", cause))),
  );
