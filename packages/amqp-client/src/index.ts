import { TypedAmqpClient, type ConnectionError } from "@amqp-contract/client";
import {
  Config,
  Env,
  type ConfigInvalid,
  type EnvReading,
  type MaybePinned,
  type OptionsAs,
  type Unpinned,
} from "@btravstack/config";
import { HealthCheckFailed, HealthChecks, Observers, noObserverMember } from "@btravstack/core";
import {
  Module,
  Provider,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";
import { ErrAsync, OkAsync, type AsyncResult } from "unthrown";

import { brokerLog } from "./broker-log.js";

/** A contract accepted by the underlying typed AMQP client. */
export type AnyAmqpContract = Parameters<typeof TypedAmqpClient.create>[0]["contract"];

/** What {@link amqpClient} is handed. Each option pins the variable named beside it. */
export type AmqpClientOptions = {
  /** Pins `AMQP_URL` (default `amqp://127.0.0.1:5672`). */
  readonly url?: string | undefined;
  /**
   * Pins `AMQP_CONNECT_TIMEOUT_MS` (default `5_000`): how long `create` waits
   * for the connection and topology setup before failing.
   */
  readonly connectTimeoutMs?: number | undefined;
};

/**
 * A typed AMQP client of `contract`, bound to the application's `port` for the
 * lifetime of the DI scope.
 *
 * ```ts
 * Module("Publisher")({ imports: [amqpClient(OrderClient, orderContract)] });
 * ```
 *
 * - **Configured from `AMQP_URL` and `AMQP_CONNECT_TIMEOUT_MS`**, the worker
 *   starter's variables and defaults, each pinned by its option and validated
 *   as the graph is built.
 * - **Acquired as the scope opens, closed as it ends.** A broker that does not
 *   answer within the connect timeout, handshake included, is the upstream
 *   `ConnectionError` on the startup channel.
 * - **The library's warnings and errors are reported to `Observers`**
 *   (`component: "amqp-client"`).
 * - **It contributes the `amqp-client:<port id>` health check**, failing
 *   while the client is not connected.
 */
export const amqpClient = <
  C extends AnyAmqpContract,
  const Id extends string,
  const O extends AmqpClientOptions = Record<never, never>,
>(
  port: PortClassOf<Id, TypedAmqpClient<C>>,
  contract: C,
  // `{}` only when the argument is omitted, which is when `O` is `{}` too.
  options: O & OptionsAs<O, AmqpClientOptions> = {} as never,
): Module<
  PortInstance<Id, TypedAmqpClient<C>> | HealthChecks,
  ConfigInvalid | ConnectionError,
  EnvReading<
    never,
    | Unpinned<O, "url", "AMQP_URL">
    | MaybePinned<O, "url", "AMQP_URL">
    | Unpinned<O, "connectTimeoutMs", "AMQP_CONNECT_TIMEOUT_MS">
    | MaybePinned<O, "connectTimeoutMs", "AMQP_CONNECT_TIMEOUT_MS">
  >
> => {
  const schema = Config.object({
    url: Config.pinned(
      options.url,
      Config.string("AMQP_URL", { default: "amqp://127.0.0.1:5672" }),
    ),
    connectTimeoutMs: Config.pinned(
      options.connectTimeoutMs,
      Config.integer("AMQP_CONNECT_TIMEOUT_MS", { default: 5_000, min: 0 }),
    ),
  });

  // Cast for the needs alone: over generic options the schema's own needs type
  // cannot resolve, so the annotation states the two variables.
  return Module(`AmqpClient:${port.portId}`)({
    needs: [Env],
    provides: [
      noObserverMember,
      Provider(port)({
        inject: { env: Env, observers: Observers },
        acquire: ({ env, observers }) =>
          Config.parse(
            port.portId,
            schema,
          )(env).flatMap(
            ({ url, connectTimeoutMs }) =>
              TypedAmqpClient.create({
                contract,
                urls: [url],
                connectTimeoutMs,
                logger: brokerLog(observers),
              }) as AsyncResult<ServiceOf<typeof port>, ConnectionError>,
          ),
        release: (client) => client.close().get(),
      }),
      Provider.member(HealthChecks)({
        inject: { client: port },
        sync: ({ client }) => ({
          name: `amqp-client:${port.portId}`,
          check: () =>
            client.isConnected()
              ? OkAsync()
              : ErrAsync(new HealthCheckFailed({ reason: "not connected to the broker" })),
        }),
      }),
    ],
    exports: [port, HealthChecks],
  }) as never;
};
