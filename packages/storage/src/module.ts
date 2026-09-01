import { HealthCheckFailed, HealthChecks, Observers, noObserver } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { Err, Ok, P } from "unthrown";

import { instrument } from "./instrument.js";
import { Storage, StorageBackend } from "./storage.js";

export type StorageOptions<E, N> = {
  /**
   * The adapter module: `memoryStorage()` from this entry point, `s3Storage()`
   * from `@btravstack/storage/s3`, or one an application wrote itself over
   * `StorageBackend`.
   */
  readonly adapter: Module<StorageBackend, E, N>;
};

/**
 * The storage starter: an adapter, and `Storage` provided from it —
 * instrumented or not, decided here at the composition root.
 *
 * ```ts
 * storage({ adapter: s3Storage() });                      // spans, counts, log lines
 * storage({ adapter: s3Storage(), instrumented: false }); // just a store
 * ```
 *
 * **Two ports, because di allows one provider per port per graph**: the port an
 * application depends on must not be the one an adapter provides, which is also
 * why instrumentation is a flag on the composition rather than a wrapper.
 */
export const storage = <E, N>({
  adapter,
}: StorageOptions<E, N>): Module<Storage | HealthChecks, E, N> => {
  const healthCheck = Provider.member(HealthChecks)({
    inject: { backend: StorageBackend },
    sync: ({ backend }) => ({
      name: "storage",
      // The probe key is never written, so `ObjectNotFound` is the
      // store ANSWERING and therefore healthy; only the adapter
      // reporting it could not reach the store at all is unhealthy.
      check: () =>
        backend
          .get("btravstack:health")
          .map((): void => undefined)
          .flatMapErrCases((matcher) =>
            matcher
              .with(P.tag("ObjectNotFound"), () => Ok<void>(undefined))
              .with(P.tag("StorageUnavailable"), ({ reason }) =>
                Err(new HealthCheckFailed({ reason: `storage unavailable (${reason})` })),
              ),
          ),
    }),
  });

  return Module("Storage")({
    imports: [adapter],
    provides: [
      // The no-op member, so the set this module reads is never the empty
      // dependency di refuses: a graph composing no observability still starts.
      Provider.member(Observers)({ inject: {}, value: noObserver }),
      Provider(Storage)({
        inject: { backend: StorageBackend, observers: Observers },
        sync: ({ backend, observers }) => instrument(backend, observers),
      }),
      healthCheck,
    ],
    exports: [Storage, HealthChecks],
  } as never) as unknown as Module<Storage | HealthChecks, E, N>;
};
