import type { Runtime } from "@btravstack/start";
import { Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import type { OrderContract } from "@btravstack/start-example-order-temporal-contract";
import {
  activityUnits,
  temporalRuntime,
  type ActivityUnitContext,
  type TemporalInfo,
  type WorkflowSource,
} from "@btravstack/start-temporal";
import {
  declareActivitiesHandler,
  type ActivityImplementationFor,
} from "@temporal-contract/worker/activity";
import type { NativeConnection } from "@temporalio/worker";
import { P } from "unthrown";

/**
 * How long an activity that is *cancellation-aware* gets to notice the
 * shutdown. Set explicitly because Temporal's default is `0`, and cancelling
 * the instant `drain` is called would fight the kernel's own drain deadline for
 * the same decision.
 */
const SHUTDOWN_GRACE = "10 seconds";

/**
 * Temporal's `shutdownForceTime`: the hard stop, after which `run()` settles
 * and in-flight work is abandoned where it stands.
 *
 * The clock is Temporal's **own**, and it is not the kernel's deadline: the
 * runtime hands the kernel its thread back the moment `drainTimeoutMs` passes,
 * whatever the worker is still doing. Keeping this at or below `drainTimeoutMs`
 * — whose kernel default is `20_000` — is what lets the worker finish forcing
 * itself down before the kernel gives up on it. It matters most on the
 * `stop()`-only path, where no kernel deadline is in play at all and this clock
 * alone decides when `Serving.stop` returns. Raise it and `drainTimeoutMs`
 * together, never one alone.
 */
const SHUTDOWN_FORCE = "15 seconds";

/**
 * The ports this runtime resolves out of the application context — the same two
 * the queue worker needs, and for the same reason: `FindOrder` is not part of
 * any activity this worker registers, and a runtime declares what *it* needs
 * rather than what the module happens to export.
 *
 * Non-empty on purpose: it is what makes `start`'s arity gate mean something
 * (`src/needs-gate.test-d.ts` pins both directions).
 */
type TemporalNeeds = typeof PlaceOrder | typeof Logger;

/**
 * A `Runtime` serving the order application as a Temporal worker — and, since
 * `@btravstack/start-temporal` shipped, no longer a hand-rolled one.
 *
 * What is left here is the application's half: the contract, the two ports the
 * activity resolves, and the triage from a domain `Err` to a declared contract
 * error. The Worker's lifecycle, the unit per activity attempt and the release
 * at the kernel's deadline are the package's, which is the point — the third
 * deployment consumes a runtime package exactly as `order-api` consumes
 * `@btravstack/start-http`.
 *
 * `activityUnits` is the one line a `temporal-contract` user adds. Its type
 * argument is not optional dressing: TypeScript infers the injected context
 * from the middleware's own type, and infers nothing from a generic call it is
 * still resolving, so writing it bare would leave `context` empty inside the
 * implementation below.
 */
export const temporalWorkerRuntime = ({
  contract,
  ...transport
}: {
  /**
   * The contract, and with it the task queue this worker polls. Specs scope a
   * per-test queue with `withTaskQueue`, so the queue is read off the contract
   * rather than passed separately.
   */
  readonly contract: OrderContract;
  /**
   * An open connection to the Temporal service. Handed in rather than opened
   * here, exactly as the queue runtime is handed its broker: `main.ts` builds
   * one from the environment, and a spec passes the test environment's.
   */
  readonly connection: NativeConnection;
  readonly namespace?: string;
  readonly workflows: WorkflowSource;
}): Runtime<TemporalNeeds, TemporalInfo> =>
  // `...transport` rather than three named fields: `connection`, `namespace`
  // and `workflows` are the package's own options under the package's own
  // names, and spreading them keeps `namespace` optional instead of
  // reintroducing it as `string | undefined`, which `exactOptionalPropertyTypes`
  // would reject.
  temporalRuntime({
    ...transport,
    taskQueue: contract.taskQueue,
    needs: [PlaceOrder, Logger],
    activities: (host) =>
      declareActivitiesHandler({
        contract,
        middleware: activityUnits<TemporalNeeds>(host),
        activities: { placeOrder: { place: placeActivity } },
      }),
    gracePeriod: SHUTDOWN_GRACE,
    forceAfter: SHUTDOWN_FORCE,
  });

/**
 * The one activity, and the hinge of this whole example.
 *
 * The `mapErrCases` is the triage point, and the third sibling of
 * `order-api`'s into `ORPCError` codes and `order-worker`'s into
 * ack/dead-letter. The same `Err` lands somewhere else again: `DuplicateOrder`
 * is a `CONFLICT` over HTTP because a caller is waiting to be told, and a
 * dead-letter on a queue because none is. Here there *is* a caller — a
 * workflow, and behind it a client — so it becomes a typed contract error the
 * client branches on by name. What is new is the second thing this mapping
 * decides: `contract.ts` declares both of these `nonRetryable`, so naming a
 * failure here is also what tells **Temporal** to stop retrying it. An
 * unmodelled failure stays unnamed and the retry policy takes over — the
 * platform doing for free what the queue worker hand-rolls with an attempt
 * budget.
 *
 * Every case is named. A new domain error is a compile error here, at the one
 * place that has to decide what the workflow sees.
 *
 * It reads the application context off `helpers.context`, which is where the
 * middleware put it. There is no `host.run` here and no `Result` unwrapping:
 * the unit boundary is the package's and the `Result` → activity failure
 * mapping is `declareActivitiesHandler`'s.
 */
const placeActivity: ActivityImplementationFor<
  OrderContract,
  "placeOrder",
  "place",
  ActivityUnitContext<TemporalNeeds>
> = (args, { context, errors }) =>
  context.ctx
    .get(PlaceOrder)
    .execute(args.orderId, args.quantity)
    .map((order) => ({ id: order.id, quantity: order.quantity }))
    .mapErrCases((matcher) =>
      matcher
        .with(P.tag("InvalidQuantity"), (error) => errors.InvalidQuantity({ id: error.id }))
        .with(P.tag("DuplicateOrder"), (error) => errors.OrderAlreadyPlaced({ id: error.id })),
    );
