import { Config, Env } from "@btravstack/config";
import { Logger, Meter, Tracer } from "@btravstack/core";
import { Module, Port, Provider, type PortClassOf } from "@btravstack/di";
import { PrismaPg } from "@prisma/adapter-pg";
import { OkAsync, fromSafePromise, type AsyncResult } from "unthrown";

import { instrument } from "./instrument.js";
import { enableTracing } from "./tracing.js";

/**
 * All this starter needs of a client: a pool it can close. A generated Prisma
 * client satisfies it structurally, and so does an extended one — `$extends`
 * preserves `$disconnect` — which is why the application's own client type
 * flows through untouched.
 */
export type PrismaLike = { readonly $disconnect: () => Promise<void> };

/** What {@link prismaDatabase} is handed. */
export type PrismaOptions<C extends PrismaLike, Instrumented extends boolean> = {
  /**
   * Builds the client. The driver adapter is already constructed from the
   * environment's URL; the second argument is that URL, for a client that wants
   * it directly.
   *
   * This is the one thing the starter cannot own: a Prisma client is
   * **generated per application** from its own schema, so there is no client
   * type to ship. Applying `@unthrown/prisma`'s extension belongs here too, so
   * the returned type is exactly the one the application will hold.
   */
  readonly client: (adapter: PrismaPg, url: string) => C;
  /** The variable the connection string is read from. `DATABASE_URL` by 12-factor convention. */
  readonly urlVar?: string;
  /**
   * Span, count and log every query. **Default `true`**, `false` opts out — the
   * same shape as `cache`, `mailer` and `storage`, and as `StartOptions`'
   * `signals` and `probes`.
   *
   * On by default because telemetry that is missing is discovered during an
   * incident. The cost is stated rather than hidden: instrumenting puts
   * `Logger`, `Meter` and `Tracer` in the provider's dependencies, so a root
   * without `observability()` and `otel()` gets a compile error naming all
   * three. It also turns on Prisma's own engine-level tracing when
   * `@prisma/instrumentation` is installed — no wiring at the root.
   */
  readonly instrumented?: Instrumented;
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
  <C extends PrismaLike, Instrumented extends boolean = true>({
    client,
    urlVar = "DATABASE_URL",
    instrumented,
  }: PrismaOptions<C, Instrumented>) => {
    const config = Config.provider(`${name}Config`)(Config.object({ url: Config.string(urlVar) }));

    // A CAST, not a class expression, and this is the same TS4023 that shapes
    // `HttpRouterPort`: a class expression's type expands di's brand keys into
    // a consumer's declaration emit, where they cannot be named. Spelling the
    // port through `PortClassOf` keeps the emitted type nameable. Without it,
    // `pnpm build` fails here — measured, not anticipated.
    const DatabasePort = Port(name) as PortClassOf<N, C>;

    // Pinned to `string` for THIS call alone. `Provider` reads a port's service
    // type through `PortInstance<string, infer S>`, and while `N` is still a
    // generic parameter that inference defers and `S` lands on `never`. The
    // returned `port` keeps the literal `N`, so a consumer still sees its own
    // port id.
    const open = (url: string): C => client(new PrismaPg({ connectionString: url }), url);
    const port = DatabasePort as PortClassOf<string, C>;

    // Both arms are built and one is chosen, so the conditional return type is
    // spelled by the arms themselves rather than by naming di's provider type.
    // Building the unused one costs a descriptor; `Provider` constructs nothing.
    //
    // The seam differs from `cache`'s deliberately: there, instrumentation is a
    // second port layering over the adapter's, because di allows one provider
    // per port per graph. Here a `query` extension wraps the client at
    // construction, so one port suffices and the branch lives inside `acquire`.
    const instrumentedProvider = Provider(port)(
      { settings: config.port, logger: Logger, tracer: Tracer, meter: Meter },
      {
        // `Tracer` is depended on for its ORDERING, not its value: nothing
        // reads it, but `otel()` sets the global tracer provider while building
        // that very port, so naming it is what guarantees the SDK is up before
        // `enableTracing` asks for it. A root without `otel()` gets a compile
        // error instead of tracing into nothing.
        acquire: ({ settings, logger, tracer, meter }): AsyncResult<C, never> => {
          void tracer;
          // Cast because `C` is only constrained by `PrismaLike`, so unthrown's
          // `NotThenable` guard cannot prove a client is not a promise. It is
          // whatever the application's `client` arrow returned.
          return fromSafePromise(
            enableTracing(logger).then(() => instrument(open(settings.url), logger, meter)),
          ) as AsyncResult<C, never>;
        },
        release: (db: C) => db.$disconnect(),
      },
    );

    // Both callbacks are annotated, and that is load-bearing rather than
    // decoration: `PortClassOf<N, C>` leaves the service type a conditional
    // TypeScript cannot resolve while `N` and `C` are still generic, so without
    // these the inferred parameter is `never` and neither arm assigns.
    //
    // Opening cannot fail in the application's terms — Prisma dials on the
    // first statement, not here — which is why the error channel is empty.
    const plainProvider = Provider(port)(
      { settings: config.port },
      {
        acquire: ({ settings }): AsyncResult<C, never> => OkAsync(open(settings.url)),
        release: (db: C) => db.$disconnect(),
      },
    );

    // A MODULE, not three loose pieces. An application writes
    // `imports: [database]` and reads `database.port`; the config provider and
    // the resourceful provider are never its business, which is the bargain
    // `cache({ adapter })` already makes. `needs` differs per arm because the
    // instrumented provider reads three more ports.
    const instrumentedModule = Module(name)({
      needs: [Env, Logger, Meter, Tracer],
      provides: [config, instrumentedProvider],
      exports: [DatabasePort],
    });

    const plainModule = Module(name)({
      needs: [Env],
      provides: [config, plainProvider],
      exports: [DatabasePort],
    });

    const chosen = (
      instrumented !== false ? instrumentedModule : plainModule
    ) as Instrumented extends true ? typeof instrumentedModule : typeof plainModule;

    // The port rides the module because it is minted from `name` HERE, so an
    // application has no other handle on it — the counterpart of
    // `@btravstack/cache` exporting a fixed `Cache` class it never has to mint.
    // The cast is what carries BOTH halves: `Object.assign` over a conditional
    // first argument widens to the added property alone, dropping the module's
    // own shape.
    return Object.assign(chosen, { port: DatabasePort }) as (Instrumented extends true
      ? typeof instrumentedModule
      : typeof plainModule) & { readonly port: PortClassOf<N, C> };
  };
