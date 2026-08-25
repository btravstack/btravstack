import type { LoggerService } from "@btravstack/core";

/** What `@prisma/instrumentation` gives us, narrowed to what is used here. */
type Instrumentation = { readonly enable: () => void; readonly disable: () => void };
type Loader = () => Promise<{ new (): Instrumentation }>;

/** Injected so a spec can drive the arm where the optional peer is absent. */
const defaultLoader: Loader = async () =>
  (await import("@prisma/instrumentation")).PrismaInstrumentation as unknown as {
    new (): Instrumentation;
  };

/**
 * Prisma's own OpenTelemetry instrumentation, turned on if it is installed.
 *
 * **A dynamic import, and it has to be**: `@prisma/instrumentation` is an
 * OPTIONAL peer, so a static import would make every consumer install it. The
 * import is attempted once, when the instrumented client is built, and a
 * failure to resolve is an ordinary answer rather than a fault — an application
 * that never wanted engine tracing simply does not have the package.
 *
 * **This can be a provider at all** because `@prisma/instrumentation` patches no
 * modules: `enable()` sets a helper on `globalThis` under a versioned key, and
 * a Prisma client reads it PER QUERY. Registration order is therefore free, and
 * this works after `@prisma/client` is imported and after clients are built.
 * The `--import` preload rule in `@btravstack/observability` governs
 * instrumentations that patch, and does not reach this one.
 *
 * **The skip is logged, not silent.** Telemetry you believe you have and do not
 * is worse than none, so the one path that quietly produces no spans says so at
 * `debug` — the level for something that is a choice rather than a fault.
 */
export const enableTracing = async (
  logger: LoggerService,
  load: Loader = defaultLoader,
): Promise<Instrumentation | undefined> => {
  try {
    const Instrumentation = await load();
    const instrumentation = new Instrumentation();
    instrumentation.enable();
    return instrumentation;
  } catch {
    logger.debug(
      "engine-level tracing is off: @prisma/instrumentation is not installed. Queries are still counted and failures still logged.",
    );
    return undefined;
  }
};
