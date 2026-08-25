import { Tracer } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { OkAsync } from "unthrown";

/** The live instrumentation, held so the scope can turn it off again. */
class PrismaTracing extends Port("PrismaTracing")<PrismaInstrumentation> {}

/**
 * Prisma's own OpenTelemetry instrumentation, as a module.
 *
 * ```ts
 * imports: [prismaDatabase("OrderDatabase")({ client }), observability(), otel(), prismaTracing()];
 * ```
 *
 * It traces at the **engine** level — the real SQL, the connection acquisition,
 * the serialisation — all of it below what a client-level wrapper can reach.
 * That is why `prismaDatabase`'s own instrumentation emits no span: it would be
 * a second, shallower span on every query. What that one keeps is the pair this
 * does not do at all, a metric and an error line.
 *
 * **`Tracer` is a dependency for its ORDERING, not its value.** Nothing here
 * reads it. `PrismaInstrumentation` resolves the global tracer provider when
 * `enable()` runs, and `otel()` sets that global while building the very port
 * named here — so depending on it is what guarantees the SDK is up first. A
 * root without `otel()` gets a compile error rather than silently tracing into
 * a no-op provider.
 *
 * **Order of registration is otherwise free**, which is why this can be a
 * provider at all. `@prisma/instrumentation` does not patch modules the way
 * `@opentelemetry/auto-instrumentations-node` does — `enable()` sets a helper
 * on `globalThis` under a versioned key, and a Prisma client looks it up **per
 * query**. So it works after `@prisma/client` is imported and after clients are
 * built, and the `--import` preload rule that governs patching instrumentations
 * does not apply to it.
 *
 * Merely importing this module is enough: di builds a scope's providers
 * eagerly, so nothing has to resolve `PrismaTracing` for the instrumentation to
 * come on. It goes off again when the scope closes.
 */
/**
 * The instrumentation's own options, derived from its constructor: the type is
 * declared in `@prisma/instrumentation` but not exported, so naming it would
 * mean copying a shape that can drift.
 */
export type PrismaTracingOptions = ConstructorParameters<typeof PrismaInstrumentation>[0];

export const prismaTracing = (options?: PrismaTracingOptions) =>
  Module("PrismaTracing")({
    needs: [Tracer],
    provides: [
      Provider(PrismaTracing)(
        { tracer: Tracer },
        {
          acquire: ({ tracer }) => {
            void tracer;
            const instrumentation = new PrismaInstrumentation(options);
            instrumentation.enable();
            return OkAsync(instrumentation);
          },
          release: (instrumentation) => {
            instrumentation.disable();
            return Promise.resolve();
          },
        },
      ),
    ],
    exports: [PrismaTracing],
  });
