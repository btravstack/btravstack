import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import type { Scope } from "@btravstack/di";
import { Module, Port, Provider } from "@btravstack/di";
import { createClient, type RedisClientType } from "redis";
import { fromPromise, fromSafePromise } from "unthrown";

import { CacheBackend, CacheUnavailable, type CacheHit, type CacheService } from "./cache.js";

/** What the graph bound from the environment for the Redis adapter. */
export class CacheConfig extends Port("CacheConfig")<{ readonly url: string }> {}

/**
 * `REDIS_URL`, required.
 *
 * No default: a cache quietly pointed at `localhost` in a deployment that
 * meant to set this would look like it was working, and would be one pod's
 * private connection failure repeated. An unset variable is a
 * `ConfigInvalid` naming it, at graph build — exit `78` under `runMain`,
 * before a single read is served.
 */
export const redisSchema = Config.object({ url: Config.string("REDIS_URL") });

/**
 * The connection, as a port of its own.
 *
 * A resourceful provider hands `release` the service it acquired, so the
 * thing that must be closed has to BE a service — which the cache's own
 * three methods are not. A private port carrying the client is the shape
 * that leaves, and `@btravstack/observability`'s `OtelSdk` is the same move
 * for the same reason: the resource rides the graph so the scope closing is
 * what closes it, on every exit path the kernel has.
 */
class RedisConnection extends Port("RedisConnection")<RedisClientType> {}

/**
 * The adapter's service over a connected client.
 *
 * Values are JSON: the port's value is `unknown`, Redis stores strings, and
 * JSON is what every other reader of that database already speaks. A value
 * `JSON.stringify` cannot take — a cycle, a BigInt — is a **defect** rather
 * than a `CacheUnavailable`: it is a bug in the caller, not an operational
 * state anyone could recover from, and modelling it would put an arm on
 * every call site that no correct program can reach.
 */
export const redisCacheBackend = (client: RedisClientType): CacheService => ({
  get: (key) =>
    fromPromise(client.get(key), () => new CacheUnavailable({ operation: "get", key })).map(
      (raw): CacheHit | undefined =>
        raw === null ? undefined : { value: JSON.parse(raw) as unknown },
    ),
  set: (key, value, options) =>
    fromPromise(
      options?.ttlMs === undefined
        ? client.set(key, JSON.stringify(value))
        : client.set(key, JSON.stringify(value), {
            expiration: { type: "PX", value: options.ttlMs },
          }),
      () => new CacheUnavailable({ operation: "set", key }),
    ).map(() => undefined),
  delete: (key) =>
    fromPromise(client.del(key), () => new CacheUnavailable({ operation: "delete", key })).map(
      () => undefined,
    ),
});

/**
 * The Redis adapter: one connection, opened with the scope and closed with
 * it, and `CacheBackend` over it.
 *
 * Nothing here is per call — a client per operation would spend a round trip
 * on a handshake to save nothing, and would leave the drain with sockets it
 * does not know about.
 */
export const redisCache = (): Module<CacheBackend, ConfigInvalid, Env | Scope> =>
  Module("RedisCache")({
    // The adapter reads `REDIS_URL`, so it owes `Env` — which nothing here
    // provides and `start` supplies at the root.
    needs: [Env],
    provides: [
      Config.provider(CacheConfig)(redisSchema),
      Provider(RedisConnection)(
        { config: CacheConfig },
        {
          acquire: ({ config }) => {
            const client = createClient({ url: config.url }) as RedisClientType;
            return fromSafePromise(client.connect()).map(() => client);
          },
          release: (client) => client.close(),
        },
      ),
      Provider(CacheBackend)(
        { client: RedisConnection },
        { sync: ({ client }) => redisCacheBackend(client) },
      ),
    ],
    exports: [CacheBackend],
  });
