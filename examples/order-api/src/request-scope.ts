import { Logger, Meter } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { UnitSpanModule } from "@btravstack/observability/otel";

/**
 * A service that exists for the length of one request and is torn down with it.
 *
 * The application scope is opened once, by the kernel, and holds the database —
 * reopening it per request would give every request its own empty in-memory
 * database. Passing this module as `StartOptions.unit` (see `main.ts`) makes
 * the kernel fork a short-lived scope over the one already built, per request:
 * a request-scoped provider reads what the parent constructed (`Logger`, here)
 * without rebuilding it, and no handler code manages the fork.
 */
export class RequestSpan extends Port("RequestSpan")<{ readonly finish: () => void }> {}

/**
 * `onStop` is what puts `Scope` in this module's needs, and only a fork (or
 * `Module.scoped`) opens one — so the teardown below cannot be forgotten. It
 * runs while the unit is still open, which is what gives the line the request's
 * own trace id.
 */
export const RequestModule = Module("Request")({
  // The fork seam: `Logger` and `Meter` are read out of the application scope
  // this per-request module is forked from. `UnitSpanModule` rides along, so
  // every request also opens an OTel span carrying the same unit ids the
  // logger stamps — its own `needs: [Tracer]` travels with the import.
  needs: [Logger, Meter],
  imports: [UnitSpanModule],
  provides: [
    Provider(RequestSpan)(
      { logger: Logger, meter: Meter },
      {
        sync: ({ logger, meter }) => {
          const startedAt = Date.now();
          const duration = meter.createHistogram("btravstack.request.duration", { unit: "ms" });
          return {
            finish: () => {
              const durationMs = Date.now() - startedAt;
              duration.record(durationMs);
              logger.info("request finished", { durationMs });
            },
          };
        },
        onStop: (span) => span.finish(),
      },
    ),
  ],
  exports: [RequestSpan],
});
