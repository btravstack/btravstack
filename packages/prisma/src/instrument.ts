import type { LoggerService, MeterService } from "@btravstack/core";

import type { PrismaLike } from "./prisma.js";

/** The `query` extension component, as this package uses it. */
type QueryExtension = {
  readonly query: {
    readonly $allModels: {
      readonly $allOperations: (args: {
        readonly model: string | undefined;
        readonly operation: string;
        readonly args: unknown;
        readonly query: (args: unknown) => Promise<unknown>;
      }) => Promise<unknown>;
    };
  };
};

/** What applying an extension needs, which `PrismaLike` deliberately does not require. */
type Extendable = { readonly $extends: (extension: QueryExtension) => unknown };

/**
 * Every query, wrapped: a span around it, a count of how it came out, and a log
 * line if it failed.
 *
 * **This is why a generated client can be instrumented at all.** Prisma's
 * `$extends` takes a `query` component, and `$allModels.$allOperations`
 * intercepts every operation on every model — so the wrapper never needs to
 * know the schema, which is the thing this package cannot see. An earlier
 * revision of this package claimed instrumentation was impossible for that
 * reason; it was wrong, and this is the mechanism it missed.
 *
 * **It deliberately opens no span.** `@btravstack/prisma/otel` enables Prisma's
 * own `@prisma/instrumentation`, which traces at the ENGINE level — the real
 * SQL, the connection acquisition, the serialisation — all of it below what a
 * client-level wrapper can see. Emitting a span here as well would put two
 * spans on every query for strictly less information. What this wrapper keeps
 * is the pair Prisma's instrumentation does not do at all: a metric, and an
 * error line correlated with the ambient unit.
 *
 * The wrapper is transparent to the answer: whatever the query resolves or
 * rejects with is what the caller receives, which is the kernel's own `RunUnit`
 * rule one layer down. `Promise.reject` re-raises rather than `throw`, so the
 * rejection propagates to `@unthrown/prisma`'s `try*` twin without this file
 * needing a `no-throw` exemption.
 */
export const instrument = <C extends PrismaLike>(
  client: C,
  logger: LoggerService,
  meter: MeterService,
): C => {
  // One counter per scope, read per call: an instrument is built from the meter
  // once, and it is the ATTRIBUTES that vary — the same per-construction /
  // per-call split `createLogger` documents for the ambient record.
  const operations = meter.createCounter("btravstack.database.operations", {
    description: "Database queries, by model, operation and outcome",
  });

  const extension: QueryExtension = {
    query: {
      $allModels: {
        $allOperations: ({ model, operation, args, query }) => {
          const label = model ?? "raw";

          return query(args).then(
            (value) => {
              operations.add(1, { model: label, operation, outcome: "ok" });
              return value;
            },
            (cause: unknown) => {
              operations.add(1, { model: label, operation, outcome: "error" });
              logger.error("a database query failed", { model: label, operation }, cause);
              return Promise.reject(cause);
            },
          );
        },
      },
    },
  };

  // A `query`-only extension intercepts calls without adding or removing any
  // model surface, so the extended client IS a `C` — which `$extends`'s own
  // return type, built for extensions that DO add surface, cannot express.
  return (client as unknown as Extendable).$extends(extension) as C;
};
