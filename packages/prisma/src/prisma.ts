import { Config, Env } from "@btravstack/config";
import {
  HealthCheckFailed,
  HealthChecks,
  Instrumentations,
  Logger,
  Observers,
  noObserver,
} from "@btravstack/core";
import { Module, Port, Provider, type PortClassOf } from "@btravstack/di";
import { PrismaPg } from "@prisma/adapter-pg";
import { fromPromise, fromSafePromise, type AsyncResult } from "unthrown";

import { instrument } from "./instrument.js";
import { loadPrismaInstrumentation } from "./tracing.js";

/**
 * All this starter needs of a client: a pool it can close. A generated Prisma
 * client satisfies it structurally, and so does an extended one — `$extends`
 * preserves `$disconnect` — which is why the application's own client type
 * flows through untouched.
 */
export type PrismaLike = {
  readonly $disconnect: () => Promise<void>;
  /**
   * What the health check asks. Part of the contract rather than optional
   * because every generated Prisma client has it, and a probe that has to
   * feature-detect its own client cannot report the difference between "the
   * database is down" and "this client cannot be asked".
   */
  readonly $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/** What {@link prismaDatabase} is handed. */
export type PrismaOptions<C extends PrismaLike> = {
  /**
   * Builds the client from the driver adapter, which is already constructed
   * from the environment's URL.
   *
   * This is the one thing the starter cannot own: a Prisma client is
   * **generated per application** from its own schema, so there is no client
   * type to ship. Applying `@unthrown/prisma`'s extension belongs here too, so
   * the returned type is exactly the one the application will hold.
   */
  readonly client: (adapter: PrismaPg) => C;
};

/**
 * A Prisma client whose pool is the application scope's.
 *
 * Returns the three pieces a composition root needs and nothing more: the
 * `config` provider binding the connection string, the `port` the client is
 * reached through, and the resourceful `provider` that opens it and closes it
 * again. Put both providers in a module's `provides` and export the port.
 *
 * **The pool closes on every exit path**, including a boot that fails after
 * this provider ran — that is what makes it resourceful rather than a plain
 * value. `$disconnect` ends the driver adapter's pool without killing the
 * client; Prisma dials again lazily on the next statement, which is why no
 * spec asserts that a released client refuses to query.
 *
 * **Migrations are not run here.** A deployment runs `prisma migrate deploy`
 * against this same URL *before the process starts*; an application that
 * migrates itself at boot races every other replica.
 */
export const prismaDatabase =
  <const N extends string>(name: N) =>
  <C extends PrismaLike>({ client }: PrismaOptions<C>) => {
    const config = Config.provider(`${name}Config`)(
      Config.object({ url: Config.string("DATABASE_URL") }),
    );

    // A CAST, not a class expression, and this is the same TS4023 that shapes
    // `OrpcRouterPort`: a class expression's type expands di's brand keys into
    // a consumer's declaration emit, where they cannot be named. Spelling the
    // port through `PortClassOf` keeps the emitted type nameable. Without it,
    // `pnpm build` fails here — measured, not anticipated.
    const DatabasePort = Port(name) as PortClassOf<N, C>;

    // Pinned to `string` for THIS call alone. `Provider` reads a port's service
    // type through `PortInstance<string, infer S>`, and while `N` is still a
    // generic parameter that inference defers and `S` lands on `never`. The
    // returned `port` keeps the literal `N`, so a consumer still sees its own
    // port id.
    const open = (url: string): C => client(new PrismaPg({ connectionString: url }));
    const port = DatabasePort as PortClassOf<string, C>;

    // Both arms are built and one is chosen, so the conditional return type is
    // spelled by the arms themselves rather than by naming di's provider type.
    // Building the unused one costs a descriptor; `Provider` constructs nothing.
    //
    // The seam differs from `cache`'s deliberately: there, instrumentation is a
    // second port layering over the adapter's, because di allows one provider
    // per port per graph. Here a `query` extension wraps the client at
    // construction, so one port suffices and the branch lives inside `acquire`.
    const clientProvider = Provider(port)({
      inject: { settings: config.port, observers: Observers },
      acquire: ({ settings, observers }): AsyncResult<C, never> => {
        // Cast because `C` is only constrained by `PrismaLike`, so unthrown's
        // `NotThenable` guard cannot prove a client is not a promise. It is
        // whatever the application's `client` arrow returned.
        return fromSafePromise(
          Promise.resolve(instrument(open(settings.url), observers)),
        ) as AsyncResult<C, never>;
      },
      release: (db: C) => db.$disconnect(),
    });

    // A MODULE, not three loose pieces. An application writes
    // `imports: [database]` and reads `database.port`; the config provider and
    // the resourceful provider are never its business, which is the bargain
    // `cache({ adapter })` already makes. `needs` differs per arm because the
    // instrumented provider reads three more ports.
    // `SELECT 1` rather than `$connect()`: a pooled client reports connected
    // while the server behind it is gone, so the probe has to make the server
    // answer something.
    const healthCheck = Provider.member(HealthChecks)({
      inject: { db: port },
      sync: ({ db }) => ({
        name,
        check: () =>
          fromPromise(
            db.$queryRaw`SELECT 1`,
            (cause: unknown) =>
              new HealthCheckFailed({
                reason: cause instanceof Error ? cause.message : "database unreachable",
              }),
          ).map((): void => undefined),
      }),
    });

    // Offered, not registered: nothing loads it unless an OTel SDK is composed.
    // The one `Logger` this starter still holds, and the reason the module
    // needs one: whether the optional peer loaded is a STARTUP fact, not an
    // operation, so the `Observers` seam has nothing to settle for it.
    const instrumentation = Provider.member(Instrumentations)({
      inject: { logger: Logger },
      sync:
        ({ logger }) =>
        () =>
          loadPrismaInstrumentation(logger),
    });

    const chosen = Module(name)({
      needs: [Env, Logger],
      provides: [
        config,
        // The no-op member, so the set this module reads is never the empty
        // dependency di refuses: a graph composing no observability still
        // starts.
        Provider.member(Observers)({ inject: {}, value: noObserver }),
        clientProvider,
        healthCheck,
        instrumentation,
      ],
      exports: [DatabasePort, HealthChecks, Instrumentations],
    });

    // The port rides the module because it is minted from `name` HERE, so an
    // application has no other handle on it — the counterpart of
    // `@btravstack/cache` exporting a fixed `Cache` class it never has to mint.
    // The cast is what carries BOTH halves: `Object.assign` over a conditional
    // first argument widens to the added property alone, dropping the module's
    // own shape.
    return Object.assign(chosen, { port: DatabasePort }) as typeof chosen & {
      readonly port: PortClassOf<N, C>;
    };
  };
