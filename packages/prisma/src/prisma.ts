import { Config, Env } from "@btravstack/config";
import {
  HealthCheckFailed,
  HealthChecks,
  Observers,
  noObserver,
  type Operation,
  type Settle,
} from "@btravstack/core";
import { Module, Port, Provider, type PortClassOf } from "@btravstack/di";
import { fromPromise, fromSafePromise, type AsyncResult } from "unthrown";

import { queryObserver, type SqlMiddlewareLike } from "./instrument.js";

/**
 * All this starter needs of a client: a raw lane to probe with, and a runtime
 * to run the probe on and to close.
 *
 * A Prisma 8 client satisfies it structurally. Both members are part of the
 * contract rather than optional because every client has them, and a probe that
 * has to feature-detect its own client cannot report the difference between
 * "the database is down" and "this client cannot be asked".
 */
export type PrismaLike = {
  /**
   * The raw lane, required to EXIST and deliberately not described further.
   *
   * Spelling its signature out here would refuse every real client: a
   * parameter is contravariant, and the genuine `raw.sql` takes the target's
   * own interpolation union and its own row-spec type, both of which are
   * narrower than anything this package — which cannot see a contract — could
   * name. `unknown` on the property still requires it to be there, which is
   * what makes a client with no raw lane a compile error.
   */
  readonly raw: { readonly sql: unknown };
  /**
   * Required to exist, and read through the same cast for the same reason: the
   * real `execute` takes the contract's own plan type.
   */
  readonly runtime: unknown;
};

/**
 * The probe's own view of a client, reached by a cast for the reason above:
 * the real plan and statistics types are the contract's, and the only thing
 * this package does with either is build one statement and run it.
 */
type Probeable = {
  readonly raw: {
    readonly sql: (strings: TemplateStringsArray) => {
      readonly affectedCount: () => { readonly build: () => unknown };
    };
  };
  readonly runtime: () => {
    readonly query: (plan: unknown) => Promise<unknown>;
    readonly close: () => Promise<void>;
  };
};

/** The one place the cast above is spelled. */
const probeable = (db: PrismaLike): Probeable => db as unknown as Probeable;

/** What the starter hands {@link PrismaOptions.client}. */
export type PrismaBinding = {
  /** `DATABASE_URL`, read through `Config` rather than by the application. */
  readonly url: string;
  /**
   * The starter's own middleware — one `afterQuery` hook reporting every
   * query to `Observers`. Spread it into the client's `middleware` array
   * beside any of the application's own.
   */
  readonly middleware: readonly SqlMiddlewareLike[];
};

/** What {@link prismaDatabase} is handed. */
export type PrismaOptions<C extends PrismaLike> = {
  /**
   * Builds the client from what the starter bound.
   *
   * This is the one thing the starter cannot own: a Prisma 8 client is typed by
   * the application's own emitted `Contract` and constructed from its own
   * `contract.json`, so there is no client type to ship. Building it here is
   * what makes the returned type exactly the one the application will hold.
   *
   * @example
   * ```ts
   * prismaDatabase("OrderDatabase")({
   *   client: ({ url, middleware }) =>
   *     postgres<Contract>({ contractJson, url, middleware }),
   * });
   * ```
   */
  readonly client: (binding: PrismaBinding) => C;
};

/**
 * A Prisma client whose pool is the application scope's.
 *
 * Returns a module carrying the three pieces a composition root needs and
 * nothing more: the `config` provider binding the connection string, the `port`
 * the client is reached through, and the resourceful provider that opens it and
 * closes it again.
 *
 * **The pool closes on every exit path**, including a boot that fails after
 * this provider ran — that is what makes it resourceful rather than a plain
 * value. `runtime().close()` ends the pool; Prisma dials again lazily on the
 * next statement, which is why no spec asserts that a released client refuses
 * to query.
 *
 * **Migrations are not run here.** A deployment runs `prisma db migrate`
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
    const port = DatabasePort as PortClassOf<string, C>;

    // Instrumentation is a MIDDLEWARE the application spreads into its own
    // client, not a wrapper applied here. Prisma 8 has no `$extends` to layer
    // one over a built client, and it needs none: `middleware` is a
    // construction option, and an `afterQuery` hook sees every query on both
    // lanes — the ORM's and the SQL builder's — which is more than the v7
    // `$allModels` wrapper ever did.
    const clientProvider = Provider(port)({
      inject: { settings: config.port, observers: Observers },
      acquire: ({ settings, observers }): AsyncResult<C, never> =>
        // Cast because `C` is only constrained by `PrismaLike`, so unthrown's
        // `NotThenable` guard cannot prove a client is not a promise. It is
        // whatever the application's `client` arrow returned.
        fromSafePromise(
          Promise.resolve(
            client({
              url: settings.url,
              middleware: [queryObserver(observers as readonly ((o: Operation) => Settle)[])],
            }),
          ),
        ) as AsyncResult<C, never>,
      release: (db: C) => probeable(db).runtime().close(),
    });

    // `SELECT 1` terminated by `affectedCount()` rather than by a row spec: the
    // statement still runs, so the server has to answer — a pooled client
    // reports connected while the server behind it is gone — and nothing
    // decodes a row, so the probe needs no codec the application's contract may
    // not have registered.
    const healthCheck = Provider.member(HealthChecks)({
      inject: { db: port },
      sync: ({ db }) => ({
        name,
        check: () =>
          fromPromise(
            probeable(db)
              .runtime()
              .query(probeable(db).raw.sql`SELECT 1`.affectedCount().build()),
            (cause: unknown) =>
              new HealthCheckFailed({
                reason: cause instanceof Error ? cause.message : "database unreachable",
              }),
          ).map((): void => undefined),
      }),
    });

    // A MODULE, not three loose pieces. An application writes
    // `imports: [database]` and reads `database.port`; the config provider and
    // the resourceful provider are never its business, which is the bargain
    // `cache({ adapter })` already makes.
    const database = Module(name)({
      needs: [Env],
      provides: [
        config,
        // The no-op member, so the set this module reads is never the empty
        // dependency di refuses: a graph composing no observability still
        // starts.
        Provider.member(Observers)({ inject: {}, value: noObserver }),
        clientProvider,
        healthCheck,
      ],
      exports: [DatabasePort, HealthChecks],
    });

    // The port rides the module because it is minted from `name` HERE, so an
    // application has no other handle on it — the counterpart of
    // `@btravstack/cache` exporting a fixed `Cache` class it never has to mint.
    // The cast is what carries BOTH halves: `Object.assign` over a conditional
    // first argument widens to the added property alone, dropping the module's
    // own shape.
    return Object.assign(database, { port: DatabasePort }) as typeof database & {
      readonly port: PortClassOf<N, C>;
    };
  };
