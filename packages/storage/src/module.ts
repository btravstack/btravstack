import { Logger, Meter, Tracer } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";

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
   * Span, count and log every operation. **Default `true`** — `false` opts out,
   * the way `StartOptions`' `signals` and `probes` do.
   *
   * On by default for the reason `@btravstack/cache`'s flag is: telemetry
   * that is missing gets discovered during an incident, and the cost of the
   * loud arm is stated rather than hidden — instrumenting puts `Logger`,
   * `Meter` and `Tracer` in this module's `Needs`, so a root that has not
   * composed `observability()` and `otel()` gets a compile error naming all
   * three.
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
 * The two-port split and the conditional return type are
 * `@btravstack/cache`'s, for the same reasons: di allows one provider per
 * port per graph, so the port an application depends on must not be the one
 * an adapter provides, and instrumentation has to be a flag on the
 * composition rather than a wrapper around it.
 */
export const storage = <E, N, Instrumented extends boolean = true>({
  adapter,
  instrumented,
}: StorageOptions<E, N, Instrumented>): Module<
  Storage,
  E,
  Instrumented extends true ? N | Logger | Meter | Tracer : N
> =>
  // One signature, two graphs — so the return type is the conditional above
  // and the implementation casts once, a value-level branch reporting a
  // type-level one.
  (instrumented !== false
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
        ],
        exports: [Storage],
      })
    : Module("Storage")({
        imports: [adapter],
        provides: [
          Provider(Storage)({ backend: StorageBackend }, { sync: ({ backend }) => backend }),
        ],
        exports: [Storage],
      })) as unknown as Module<
    Storage,
    E,
    Instrumented extends true ? N | Logger | Meter | Tracer : N
  >;
