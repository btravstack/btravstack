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
import { OkAsync, fromPromise, fromSafePromise, type AsyncResult } from "unthrown";

const scheduleConfig = Config.provider("ScheduleConfig")(
  Config.object({
    address: Config.string("TEMPORAL_ADDRESS", { default: "127.0.0.1:7233" }),
    namespace: Config.string("TEMPORAL_NAMESPACE", { default: "default" }),
    tenants: Config.list("SWEEP_TENANTS"),
  }),
);

type SweepNotEnsured = WorkflowNotInContractError | WorkflowValidationError | ScheduleNotFoundError;

class ScheduleConnection extends Port("ScheduleConnection")<Connection> {}

class ScheduleClient extends Port("ScheduleClient")<Client> {}

class Schedules extends Port("Schedules")<ContractClient<OrderContract>["schedule"]> {}

const PREFIX = "sweep-stale-orders-";

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
      Provider(ScheduleClient)({
        inject: { connection: ScheduleConnection, config: scheduleConfig.port },
        sync: ({ connection, config }) => new Client({ connection, namespace: config.namespace }),
      }),
      Provider(Schedules)({
        inject: { client: ScheduleClient },
        make: ({ client }) =>
          TypedClient.create({ client }).map((typed) => typed.for(orderContract).schedule),
      }),
    ],
    exports: [Schedules, ScheduleClient, scheduleConfig.port],
  });

// The id is DERIVED from the tenant: that is the whole of the idempotence.
const sweepFor = (schedules: ServiceOf<Schedules>, tenantId: string) =>
  ensureSchedule(schedules, "sweepStaleOrders", {
    scheduleId: `${PREFIX}${tenantId}`,
    spec: { cronExpressions: ["0 3 * * *"] },
    args: { tenantId, olderThanDays: 30 },
  });

const retireAllBut = (
  client: Client,
  kept: readonly string[],
): AsyncResult<readonly string[], never> =>
  fromSafePromise(
    (async () => {
      const retired: string[] = [];
      for await (const schedule of client.schedule.list())
        if (schedule.scheduleId.startsWith(PREFIX) && !kept.includes(schedule.scheduleId))
          retired.push(schedule.scheduleId);
      for (const id of retired) await client.schedule.getHandle(id).delete();
      return retired;
    })(),
  );

/**
 * Bring the namespace's sweeps in line with `SWEEP_TENANTS`: ensure one per
 * listed tenant, one after the other, then delete every `sweep-stale-orders-*`
 * schedule for a tenant no longer listed — a destructive nightly job must not
 * outlive the configuration that asked for it. Answers what each listed
 * tenant's registration did, and which schedules were retired.
 *
 * `deploy:schedules` runs this from a release's one-shot Job — never from the
 * worker's own boot, which would write the same schedules once per replica on
 * every rollout.
 */
export const deploySchedules = (env: Environment) =>
  Module.scoped(scheduling(env), (ctx) => {
    const { tenants } = ctx.get(scheduleConfig.port);
    return tenants
      .reduce<AsyncResult<readonly ScheduleOutcome[], SweepNotEnsured>>(
        (done, tenantId) =>
          done.flatMap((outcomes) =>
            sweepFor(ctx.get(Schedules), tenantId).map((outcome) => [...outcomes, outcome]),
          ),
        OkAsync([]),
      )
      .flatMap((ensured) =>
        retireAllBut(
          ctx.get(ScheduleClient),
          tenants.map((tenantId) => `${PREFIX}${tenantId}`),
        ).map((retired) => ({ ensured, retired })),
      );
  });
