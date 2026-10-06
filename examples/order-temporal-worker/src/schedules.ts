import { Config, Env, type Environment } from "@btravstack/config";
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { orderContract, type OrderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalUnreachable } from "@btravstack/temporal-worker";
import { ensureSchedule, type ScheduleOutcome } from "@btravstack/temporal-worker/schedule";
import {
  TypedClient,
  type ContractClient,
  type ScheduleNotFoundError,
  type WorkflowNotInContractError,
  type WorkflowValidationError,
} from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";
import { OkAsync, fromPromise, type AsyncResult } from "unthrown";

/**
 * What a deploy reads: the cluster the worker polls — the same two variables,
 * the same defaults — and which tenants get a sweep. `SWEEP_TENANTS` has no
 * default for `OUTBOX_TENANTS`' reason: a schedule fires outside any unit, so
 * nothing could say which tenant it is for except the deployment.
 */
const scheduleConfig = Config.provider("ScheduleConfig")(
  Config.object({
    address: Config.string("TEMPORAL_ADDRESS", { default: "127.0.0.1:7233" }),
    namespace: Config.string("TEMPORAL_NAMESPACE", { default: "default" }),
    tenants: Config.list("SWEEP_TENANTS"),
  }),
);

type SweepNotEnsured = WorkflowNotInContractError | WorkflowValidationError | ScheduleNotFoundError;

class ScheduleConnection extends Port("ScheduleConnection")<Connection> {}

class Schedules extends Port("Schedules")<ContractClient<OrderContract>["schedule"]> {}

/**
 * The deploy's graph: the configuration, a client connection released on
 * every path, and the contract's typed schedule client over it. A scope of its
 * own rather than `start`, because a deploy is a one-shot — it has no runtime,
 * no drain and no probe, and finishing IS its success.
 */
const scheduling = (env: Environment) =>
  Module("Scheduling")({
    provides: [
      Provider(Env)({ inject: {}, value: env }),
      scheduleConfig,
      Provider(ScheduleConnection)({
        inject: { config: scheduleConfig.port },
        acquire: ({ config }) =>
          fromPromise(
            Connection.connect({ address: config.address }),
            (cause) => new TemporalUnreachable({ address: config.address, cause }),
          ),
        release: (connection) => connection.close(),
      }),
      Provider(Schedules)({
        inject: { connection: ScheduleConnection, config: scheduleConfig.port },
        make: ({ connection, config }) =>
          TypedClient.create({
            client: new Client({ connection, namespace: config.namespace }),
          }).map((typed) => typed.for(orderContract).schedule),
      }),
    ],
    exports: [Schedules, scheduleConfig.port],
  });

/**
 * One tenant's nightly sweep. The schedule id is DERIVED from the tenant, which
 * is the whole of the idempotence: a second deploy names the same schedule,
 * and `ensureSchedule` turns the `ScheduleAlreadyExistsError` that earns into
 * an update. The cron and the retention window are the code's to say, not the
 * environment's — after a deploy the schedule says what this file says.
 */
const sweepFor = (schedules: ServiceOf<Schedules>, tenantId: string) =>
  ensureSchedule(schedules, "sweepStaleOrders", {
    scheduleId: `sweep-stale-orders-${tenantId}`,
    spec: { cronExpressions: ["0 3 * * *"] },
    args: { tenantId, olderThanDays: 30 },
  });

/**
 * Register every tenant's sweep, one after the other, and answer what each
 * registration did. `deploy:schedules` runs this from a release's one-shot Job
 * — never from the worker's own boot, which would write the same schedules
 * once per replica on every rollout.
 */
export const deploySchedules = (env: Environment) =>
  Module.scoped(scheduling(env), (ctx) =>
    ctx
      .get(scheduleConfig.port)
      .tenants.reduce<AsyncResult<readonly ScheduleOutcome[], SweepNotEnsured>>(
        (done, tenantId) =>
          done.flatMap((outcomes) =>
            sweepFor(ctx.get(Schedules), tenantId).map((outcome) => [...outcomes, outcome]),
          ),
        OkAsync([]),
      ),
  );
