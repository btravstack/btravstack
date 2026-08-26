import { HealthCheckFailed, HealthChecks, Logger, Meter, Tracer } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { Err, Ok, P } from "unthrown";

import { instrument } from "./instrument.js";
import { Storage, StorageBackend } from "./storage.js";

export type StorageOptions<E, N, Instrumented extends boolean> = {
  /**
   * The adapter module: `memoryStorage()` from this entry point,
   * `s3Storage()` from `@btravstack/storage/s3`, or one an application
   * wrote itself over `StorageBackend`.
   */
  readonly adapter: Module<StorageBackend, E, N>;
  /**
   * Span, count and log every operation. **Default `true`**, `false` opts out.
   *
   * On by default because telemetry that is missing is discovered during an
   * incident. The cost is stated rather than hidden: instrumenting puts
   * `Logger`, `Meter` and `Tracer` in this module's `Needs`, so a root without
   * `observability()` and `otel()` gets a compile error naming all three.
   */
  readonly instrumented?: Instrumented;
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
export const storage = <E, N, Instrumented extends boolean = true>({
  adapter,
  instrumented,
}: StorageOptions<E, N, Instrumented>): Module<
  Storage | HealthChecks,
  E,
  Instrumented extends true ? N | Logger | Meter | Tracer : N
> => {
  const healthCheck = Provider.member(HealthChecks)(
    { backend: StorageBackend },
    {
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
    },
  );

  // One signature, two graphs — so the return type is the conditional above
  // and the implementation casts once, a value-level branch reporting a
  // type-level one.
  return (instrumented !== false
    ? Module("InstrumentedStorage")({
        needs: [Logger, Meter, Tracer],
        imports: [adapter],
        provides: [
          Provider(Storage)(
            { backend: StorageBackend, logger: Logger, tracer: Tracer, meter: Meter },
            {
              sync: ({ backend, logger, tracer, meter }) =>
                instrument(backend, logger, tracer, meter),
            },
          ),
          healthCheck,
        ],
        exports: [Storage, HealthChecks],
      })
    : Module("Storage")({
        imports: [adapter],
        provides: [
          Provider(Storage)({ backend: StorageBackend }, { sync: ({ backend }) => backend }),
          healthCheck,
        ],
        exports: [Storage, HealthChecks],
      })) as unknown as Module<
    Storage | HealthChecks,
    E,
    Instrumented extends true ? N | Logger | Meter | Tracer : N
  >;
};
