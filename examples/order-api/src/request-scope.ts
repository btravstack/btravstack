import { Logger } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { UnitSpanModule } from "@btravstack/observability/otel";

/**
 * A service that exists for the length of one request and is torn down with it.
 *
 * The application scope is opened once, by the kernel, and holds the database.
 * Passing this module as `unit: { anonymous: RequestModule }` on `HttpModule`
 * makes each answerer fork a short-lived scope over the one already built,
 * for a request it handles — so a request-scoped provider reads what the
 * parent constructed without rebuilding it, and no handler code manages the
 * fork.
 */
export class RequestSpan extends Port("RequestSpan")<{ readonly finish: () => void }> {}

/**
 * `onStop` is what puts `Scope` in this module's needs, and only a fork (or
 * `Module.scoped`) opens one — so the teardown below cannot be forgotten. It
 * runs while the unit is still open, which is what gives the line the request's
 * own trace id.
 */
export const RequestModule = Module("Request")({
  // The fork seam: both are read out of the application scope this module is
  // forked from. `UnitSpanModule` rides along, so every request also opens a
  // span carrying the same unit ids the logger stamps.
  needs: [Logger],
  imports: [UnitSpanModule],
  provides: [
    Provider(RequestSpan)({
      inject: { logger: Logger },
      // No histogram here any more: `@btravstack/http-server` records
      // `btravstack.http.duration` at the unit seam, dimensioned by answerer
      // and status — which an application cannot see from inside its own
      // request scope. What is left is the LINE, which is this module's actual
      // subject: a provider whose teardown runs while the unit is still open,
      // so it carries the request's own trace id.
      sync: ({ logger }) => {
        const startedAt = Date.now();
        return {
          finish: () => logger.info("request finished", { durationMs: Date.now() - startedAt }),
        };
      },
      onStop: (span) => span.finish(),
    }),
  ],
  exports: [RequestSpan],
});
