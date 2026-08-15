import { Module, Port, Provider } from "@btravstack/di";
import { Logger } from "@btravstack/example-order-application";

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
  provides: [
    Provider(RequestSpan)([Logger], {
      sync: (logger) => {
        const startedAt = Date.now();
        return { finish: () => logger.info(`request finished in ${Date.now() - startedAt}ms`) };
      },
      onStop: (span) => span.finish(),
    }),
  ],
  exports: [RequestSpan],
});
