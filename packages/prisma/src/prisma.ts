import { Config } from "@btravstack/config";
import { Port, Provider, type PortClassOf } from "@btravstack/di";
import { PrismaPg } from "@prisma/adapter-pg";
import { OkAsync, type AsyncResult } from "unthrown";

/**
 * All this starter needs of a client: a pool it can close. A generated Prisma
 * client satisfies it structurally, and so does an extended one — `$extends`
 * preserves `$disconnect` — which is why the application's own client type
 * flows through untouched.
 */
export type PrismaLike = { readonly $disconnect: () => Promise<void> };

/** What {@link prismaDatabase} is handed. */
export type PrismaOptions<C extends PrismaLike> = {
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
  <C extends PrismaLike>({ client, urlVar = "DATABASE_URL" }: PrismaOptions<C>) => {
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
    const provider = Provider(DatabasePort as PortClassOf<string, C>)(
      { settings: config.port },
      {
        // Both callbacks are annotated, and that is load-bearing rather than
        // decoration: `PortClassOf<N, C>` leaves the service type a conditional
        // TypeScript cannot resolve while `N` and `C` are still generic, so
        // without these the inferred parameter is `never` and neither arm
        // assigns.
        //
        // Opening cannot fail in the application's terms — Prisma dials on the
        // first statement, not here — which is why the error channel is empty.
        acquire: ({ settings }): AsyncResult<C, never> =>
          OkAsync(client(new PrismaPg({ connectionString: settings.url }), settings.url)),
        release: (db: C) => db.$disconnect(),
      },
    );

    return { port: DatabasePort, config, provider };
  };
