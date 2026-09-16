import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import type { Scope } from "@btravstack/di";
import { Module, Port, Provider } from "@btravstack/di";
import { createClient, type RedisClientType } from "redis";
import { OkAsync, TaggedError, fromPromise, fromThrowable } from "unthrown";

import {
  CacheBackend,
  CacheUnavailable,
  type CacheBackendService,
  type CacheHit,
} from "./cache.js";

/**
 * The connection could not be opened at all — a wrong `REDIS_URL`, a server
 * that is not listening, credentials the server refused.
 *
 * Separate from `CacheUnavailable`, which is about one operation on one key and
 * carries both: this happens before any key exists. Modeled because it is a
 * startup failure an operator caused and can fix, so it deserves a message and
 * an exit code — see {@link CONNECT_ATTEMPTS} for what it replaced, which was
 * neither.
 */
export class CacheConnectionFailed extends TaggedError("CacheConnectionFailed")<{
  readonly reason: string;
}> {}

/**
 * How many times the FIRST connect is retried before the boot is failed.
 *
 * node-redis retries the initial connect **forever** by default (measured
 * against 6.2.1: a `REDIS_URL` nothing is listening on emits `ECONNREFUSED`
 * every few hundred milliseconds and `connect()` neither resolves nor rejects).
 * Under a kernel that is still `building`, that is a pod which answers `/livez`
 * and never `/readyz` — with no startup failure, no exit code and no report,
 * for a typo in a manifest. Kubernetes restarting the pod is the right answer
 * to a dependency that is not up yet, and it needs the process to exit to give
 * it.
 *
 * Once connected the strategy retries without limit, which is the behaviour
 * that should be unbounded: a server that came back is not a misconfiguration.
 */
const CONNECT_ATTEMPTS = 5;

/** What the graph bound from the environment for the Redis adapter. */
export class CacheConfig extends Port("CacheConfig")<{ readonly url: string }> {}

/**
 * `REDIS_URL`, required. No default: a cache quietly pointed at `localhost`
 * would look like it was working. An unset variable is a `ConfigInvalid` naming
 * it, at graph build.
 */
export const redisSchema = Config.object({ url: Config.string("REDIS_URL") });

/**
 * The connection, as a port of its own: a resourceful provider hands `release`
 * the service it acquired, so the thing that must be closed has to BE a service
 * — which the cache's three methods are not. The resource rides the graph, so
 * the scope closing is what closes it.
 */
class RedisConnection extends Port("RedisConnection")<RedisClientType> {}

/**
 * The adapter's service over a connected client. Values are JSON, which is what
 * every other reader of that database already speaks. A value `JSON.stringify`
 * cannot take is a **defect**, not a `CacheUnavailable`: a bug in the caller,
 * and an arm no correct program could reach.
 */
export const redisCacheBackend = (client: RedisClientType): CacheBackendService => ({
  get: (key) =>
    fromPromise(client.get(key), () => new CacheUnavailable({ operation: "get", key })).flatMap(
      (raw): ReturnType<CacheBackendService["get"]> =>
        raw === null
          ? OkAsync(undefined)
          : // A key another writer owns holds bytes this adapter did not encode,
            // and `JSON.parse` THROWS on them — inside `.map` that was a defect,
            // which `readThrough` does not recover, so one foreign key made
            // every `getOrSet` on it defect until the key expired. Reported as
            // the operation failing instead, which is the arm a caller already
            // degrades to a miss.
            fromThrowable(
              () => ({ value: JSON.parse(raw) as unknown }) as CacheHit | undefined,
              () => new CacheUnavailable({ operation: "get", key }),
            )().toAsync(),
    ),
  set: (key, value, options) =>
    // `JSON.stringify` is inside the pipeline, not an argument evaluated before
    // it: a `BigInt` throws, and eagerly that escaped a method typed
    // `AsyncResult` as a synchronous exception rather than as the defect this
    // package says a value it cannot encode is.
    OkAsync()
      .map(() => JSON.stringify(value))
      .flatMap((encoded) =>
        fromPromise(
          options?.ttlMs === undefined
            ? client.set(key, encoded)
            : client.set(key, encoded, { expiration: { type: "PX", value: options.ttlMs } }),
          () => new CacheUnavailable({ operation: "set", key }),
        ),
      )
      .map(() => undefined),
  delete: (key) =>
    fromPromise(client.del(key), () => new CacheUnavailable({ operation: "delete", key })).map(
      () => undefined,
    ),
});

/**
 * The Redis adapter: one connection, opened with the scope and closed with it,
 * and `CacheBackend` over it. Nothing here is per call — a client per operation
 * would spend a handshake to save nothing and leave the drain with sockets it
 * does not know about.
 */
export const redisCache = (): Module<
  CacheBackend,
  ConfigInvalid | CacheConnectionFailed,
  Env | Scope
> =>
  Module("RedisCache")({
    needs: [Env],
    provides: [
      Config.provider(CacheConfig)(redisSchema),
      Provider(RedisConnection)({
        inject: { config: CacheConfig },
        acquire: ({ config }) => {
          let connected = false;
          const client = createClient({
            url: config.url,
            socket: {
              // Handing the cause back is what ENDS the retry loop: node-redis
              // rejects `connect()` with it rather than scheduling another
              // attempt. A number is a delay, which is the arm a reconnect
              // after boot always takes.
              reconnectStrategy: (retries: number, cause: Error) =>
                connected || retries < CONNECT_ATTEMPTS
                  ? Math.min((retries + 1) * 50, 1_000)
                  : cause,
            },
          }) as RedisClientType;
          // Permanent, and deliberately silent. node-redis emits `'error'` on a
          // socket drop, a decoder fault or a failed keep-alive, and an
          // `EventEmitter` with no `'error'` listener THROWS — which the
          // kernel's `uncaughtException` handler turns into a whole-application
          // teardown at exit 70, over a fault the client's own reconnect
          // recovers from in milliseconds. Nothing is logged here because the
          // adapter holds no logger and the next operation reports itself:
          // `CacheUnavailable` is already on every method's channel, and that
          // is the line an operator should be reading.
          client.on("error", () => {});
          return fromPromise(
            client.connect(),
            (cause: unknown) =>
              new CacheConnectionFailed({
                reason: cause instanceof Error ? cause.message : "the server did not answer",
              }),
          )
            .tap(() => {
              connected = true;
            })
            .map(() => client);
        },
        release: (client) => client.close(),
      }),
      Provider(CacheBackend)({
        inject: { client: RedisConnection },
        sync: ({ client }) => redisCacheBackend(client),
      }),
    ],
    exports: [CacheBackend],
  });
