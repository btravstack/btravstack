import { Config } from "@btravstack/config";
import { RuntimePort, type Runtime } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import {
  Logger,
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import type { OrderContract } from "@btravstack/example-order-temporal-contract";
import {
  activityUnits,
  temporalRuntime,
  type ActivityUnitContext,
  type TemporalInfo,
  type WorkflowSource,
} from "@btravstack/temporal";
import {
  declareActivitiesHandler,
  type ActivityImplementationFor,
} from "@temporal-contract/worker/activity";
import { NativeConnection } from "@temporalio/worker";
import { P, TaggedError, fromPromise } from "unthrown";

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
 * The ports this runtime resolves out of the application context — one per
 * concern the saga's activities touch. `FindOrder` is not among them, and a
 * runtime declares what *it* needs rather than what the module happens to
 * export.
 *
 * Non-empty on purpose: it is what makes `start`'s arity gate mean something
 * (`src/needs-gate.test-d.ts` pins both directions).
 */
type TemporalNeeds =
  | typeof PlaceOrder
  | typeof OrderRepository
  | typeof StockService
  | typeof ShippingService
  | typeof Logger;

export type TemporalWorkerOptions = {
  /**
   * The contract, and with it the task queue this worker polls. Specs scope a
   * per-test queue with `withTaskQueue`, so the queue is read off the contract
   * rather than passed separately.
   */
  readonly contract: OrderContract;
  /** An open connection to the Temporal service — `TemporalConnection`, in the graph. */
  readonly connection: NativeConnection;
  readonly namespace?: string;
  readonly workflows: WorkflowSource;
};

/**
 * Where the Temporal service is, bound from `TEMPORAL_ADDRESS` (default
 * `127.0.0.1:7233`) and `TEMPORAL_NAMESPACE` (default `default`); a blank
 * value is a configuration error the kernel reports (`ConfigInvalid`, exit 78).
 */
export class TemporalConfig extends Port("TemporalConfig")<{
  readonly address: string;
  readonly namespace: string;
}> {}

/**
 * The connection, as a resource of the graph: di opens it with the scope and
 * closes it on every exit path — startup failure included — which is what a
 * `main.ts` opening it by hand had to `.finally` around `runMain`.
 */
export class TemporalConnection extends Port("TemporalConnection")<NativeConnection> {}

/**
 * The service at `TEMPORAL_ADDRESS` did not answer. Modeled rather than left a
 * defect because an operator *can* act on it — the address is wrong or the
 * service is down, and neither is a bug in this code — so `runMain` exits `1`,
 * a startup `Err`, not the `70` a defect earns.
 */
export class TemporalUnreachable extends TaggedError("TemporalUnreachable")<{
  readonly address: string;
  readonly cause: unknown;
}> {}

/**
 * The port `start` resolves this deployment's runtime from. The runtime's
 * `needs` are the application's, so the port is the application's to declare
 * — over the kernel's `RuntimePort` — rather than something
 * `@btravstack/temporal` could ship.
 */
export class OrderTemporalRuntime extends RuntimePort<Runtime<TemporalNeeds, TemporalInfo>> {}

/**
 * The runtime as a module: configuration from the environment, the connection
 * as a resource, and the worker built from both — so the composition root
 * imports it like every other service. Its two arguments are the deployment's
 * static facts, which is why it is a small factory rather than a constant: a
 * spec hands over a per-test queue and a prebuilt bundle where `module.ts`
 * hands over `orderContract` and the workflow module's path.
 */
export const temporalModule = ({
  contract,
  workflows,
}: Pick<TemporalWorkerOptions, "contract" | "workflows">) =>
  Module("OrderTemporal")({
    provides: [
      Config.provider(
        TemporalConfig,
        Config.object({
          address: Config.string("TEMPORAL_ADDRESS", { default: "127.0.0.1:7233" }),
          namespace: Config.string("TEMPORAL_NAMESPACE", { default: "default" }),
        }),
      ),
      Provider(TemporalConnection)([TemporalConfig], {
        acquire: ({ address }) =>
          fromPromise(
            NativeConnection.connect({ address }),
            (cause) => new TemporalUnreachable({ address, cause }),
          ),
        release: (connection) => connection.close(),
      }),
      Provider(OrderTemporalRuntime)([TemporalConnection, TemporalConfig], {
        sync: (connection, { namespace }) =>
          temporalWorkerRuntime({ contract, connection, namespace, workflows }),
      }),
    ],
    exports: [OrderTemporalRuntime],
  });

/**
 * A `Runtime` serving the order application as a Temporal worker — and, since
 * `@btravstack/temporal` shipped, no longer a hand-rolled one.
 *
 * What is left here is the application's half: the contract, the two ports the
 * activity resolves, and the triage from a domain `Err` to a declared contract
 * error. The Worker's lifecycle, the unit per activity attempt and the release
 * at the kernel's deadline are the package's, which is the point — the third
 * deployment consumes a runtime package exactly as `order-api` consumes
 * `@btravstack/http`.
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
}: TemporalWorkerOptions): Runtime<TemporalNeeds, TemporalInfo> =>
  // `...transport` rather than three named fields: `connection`, `namespace`
  // and `workflows` are the package's own options under the package's own
  // names, and spreading them keeps `namespace` optional instead of
  // reintroducing it as `string | undefined`, which `exactOptionalPropertyTypes`
  // would reject.
  temporalRuntime({
    ...transport,
    taskQueue: contract.taskQueue,
    needs: [PlaceOrder, OrderRepository, StockService, ShippingService, Logger],
    activities: (host) =>
      declareActivitiesHandler({
        contract,
        middleware: activityUnits<TemporalNeeds>(host),
        activities: {
          fulfillOrder: {
            place: placeActivity,
            reserveStock: reserveStockActivity,
            arrangeShipping: arrangeShippingActivity,
            releaseStock: releaseStockActivity,
            cancelPlacement: cancelPlacementActivity,
          },
        },
      }),
    gracePeriod: SHUTDOWN_GRACE,
    forceAfter: SHUTDOWN_FORCE,
  });

/**
 * The one activity, and the hinge of this whole example.
 *
 * The `mapErrCases` is the triage point, and the third sibling of
 * `order-api`'s into `ORPCError` codes and a queue consumer's into
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
  "fulfillOrder",
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

/**
 * The forward steps against the two external services — same triage, one case
 * each: the domain's permanent no becomes the declared contract error, which
 * `nonRetryable` in `contract.ts` turns into "stop asking".
 */
const reserveStockActivity: ActivityImplementationFor<
  OrderContract,
  "fulfillOrder",
  "reserveStock",
  ActivityUnitContext<TemporalNeeds>
> = (args, { context, errors }) =>
  context.ctx
    .get(StockService)
    .reserve(args.orderId, args.quantity)
    .mapErrCases((matcher) =>
      matcher.with(P.tag("OutOfStock"), (error) => errors.OutOfStock({ id: error.id })),
    );

const arrangeShippingActivity: ActivityImplementationFor<
  OrderContract,
  "fulfillOrder",
  "arrangeShipping",
  ActivityUnitContext<TemporalNeeds>
> = (args, { context, errors }) =>
  context.ctx
    .get(ShippingService)
    .arrange(args.orderId)
    .mapErrCases((matcher) =>
      matcher.with(P.tag("ShippingUnavailable"), (error) =>
        errors.ShippingUnavailable({ id: error.id }),
      ),
    );

/**
 * The compensations. `releaseStock`'s port already promises `never`; nothing
 * to triage. `cancelPlacement` absorbs `OrderNotFound` on purpose — undoing a
 * placement that never landed is the no-op a *repeated* compensation performs,
 * and an activity Temporal may re-run has to answer the same both times.
 */
const releaseStockActivity: ActivityImplementationFor<
  OrderContract,
  "fulfillOrder",
  "releaseStock",
  ActivityUnitContext<TemporalNeeds>
> = (args, { context }) => context.ctx.get(StockService).release(args.orderId);

const cancelPlacementActivity: ActivityImplementationFor<
  OrderContract,
  "fulfillOrder",
  "cancelPlacement",
  ActivityUnitContext<TemporalNeeds>
> = (args, { context }) =>
  context.ctx
    .get(OrderRepository)
    .remove(args.orderId)
    .recoverErrCases((matcher) => matcher.with(P.tag("OrderNotFound"), () => undefined));
