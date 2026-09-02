import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import type { Scope } from "@btravstack/di";
import { Module, Port, Provider } from "@btravstack/di";
import { createClient, type RedisClientType } from "redis";
import { fromPromise, fromSafePromise } from "unthrown";

import {
  CacheBackend,
  CacheUnavailable,
  type CacheBackendService,
  type CacheHit,
} from "./cache.js";

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
 * The Redis adapter: one connection, opened with the scope and closed with it,
 * and `CacheBackend` over it. Nothing here is per call — a client per operation
 * would spend a handshake to save nothing and leave the drain with sockets it
 * does not know about.
 */
export const redisCache = (): Module<CacheBackend, ConfigInvalid, Env | Scope> =>
  Module("RedisCache")({
    needs: [Env],
    provides: [
      Config.provider(CacheConfig)(redisSchema),
      Provider(RedisConnection)({
        inject: { config: CacheConfig },
        acquire: ({ config }) => {
          const client = createClient({ url: config.url }) as RedisClientType;
          return fromSafePromise(client.connect()).map(() => client);
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
