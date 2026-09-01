import { Env } from "@btravstack/config";
import {
  HealthChecks,
  Instrumentations,
  Logger,
  Observers,
  runHealthChecks,
} from "@btravstack/core";
import { Module, Provider, type ServiceOf } from "@btravstack/di";
import { OkAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { prismaDatabase } from "./prisma.js";

/**
 * The URL the starter put into the driver adapter. Read off the adapter rather
 * than handed to the arrow: this asserts the ADAPTER was configured, which is
 * the thing that actually reaches Postgres.
 */
const connectionStringOf = (adapter: unknown): string =>
  (adapter as { readonly config: { readonly connectionString: string } }).config.connectionString;

/**
 * The one port this starter still needs: `loadPrismaInstrumentation` says at
 * `debug` when the optional peer is absent, which is a startup fact rather than
 * an operation an observer could settle.
 */
const silentLoggerService: ServiceOf<Logger> = {
  log: () => {},
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  with: () => silentLoggerService,
  isEnabled: () => false,
};

const silentLogger = Provider(Logger)({ inject: {}, value: silentLoggerService });

describe("prismaDatabase", () => {
  it("opens the client against the URL the environment names", async ({ stub }) => {
    // GIVEN a starter over a stub client, and DATABASE_URL in the environment
    const db = prismaDatabase("OrderDatabase")({
      client: (adapter) => stub.client(connectionStringOf(adapter)),
    });
    const root = Module("Root")({
      imports: [db],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        silentLogger,
      ],
      exports: [db.port],
    });

    // WHEN the scope is opened and the port resolved
    const url = await Module.scoped(root, (ctx) => OkAsync(ctx.get(db.port).url));

    // THEN the client was built with what the environment named
    expect(url).toBeOkWith("postgres://localhost:5432/orders");
  });

  it("disconnects the client when the scope closes", async ({ stub }) => {
    // GIVEN a graph holding the client open
    const db = prismaDatabase("OrderDatabase")({
      client: (adapter) => stub.client(connectionStringOf(adapter)),
    });
    const root = Module("Root")({
      imports: [db],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        silentLogger,
      ],
      exports: [db.port],
    });

    // WHEN the scope opens and closes again
    await Module.scoped(root, (ctx) => OkAsync(ctx.get(db.port).url));

    // THEN the pool was released on the way out
    expect(stub.last()?.disconnected()).toBe(1);
  });

  it("reports a missing DATABASE_URL as a modeled error naming it", async ({ stub }) => {
    // GIVEN the same graph and an environment that names no database
    const db = prismaDatabase("OrderDatabase")({
      client: (adapter) => stub.client(connectionStringOf(adapter)),
    });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ inject: {}, value: {} }), silentLogger],
      exports: [db.port],
    });

    // WHEN the scope is opened without DATABASE_URL
    const opened = await Module.scoped(root, (ctx) => OkAsync(ctx.get(db.port).url));

    // THEN it is an Err naming the variable, not a throw
    expect(opened).toBeErrWith(
      expect.objectContaining({ issues: [expect.objectContaining({ path: ["DATABASE_URL"] })] }),
    );
  });

  it("observes a query through the graph, with no flag and no ports owed", async ({
    stub,
    observed,
  }) => {
    // GIVEN the starter in a root that owes it NOTHING beyond `Env` — the
    // observer is a set-port member, so composing one is the whole of what
    // makes the queries observed
    const db = prismaDatabase("OrderDatabase")({
      client: (adapter) => stub.client(connectionStringOf(adapter)),
    });
    const root = Module("Root")({
      imports: [db],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        silentLogger,
        ...observed.members.map((member) =>
          Provider.member(Observers)({ inject: {}, value: member }),
        ),
      ],
      exports: [db.port],
    });

    // WHEN a query runs against the client the graph handed back
    await Module.scoped(root, (ctx) =>
      fromSafePromise(ctx.get(db.port).query("Order", "findMany", Promise.resolve([]))),
    );

    // THEN it was observed — the client came out wrapped without anyone asking.
    // Untraced: engine-level tracing is `@btravstack/prisma/otel`'s job, and a
    // client-level span would only duplicate it more shallowly.
    expect(observed.taken()).toEqual([
      expect.objectContaining({
        component: "database",
        name: "findMany",
        outcome: "ok",
        traced: false,
      }),
    ]);
  });

  it("declares a health check that asks the database to answer", async ({ stub }) => {
    // GIVEN a starter over a reachable stub client
    const db = prismaDatabase("OrderDatabase")({
      client: (adapter) => stub.client(connectionStringOf(adapter)),
    });
    const root = Module("Root")({
      imports: [db],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        silentLogger,
      ],
      exports: [db.port, HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN the database answered, under the name the starter was given
    expect(report).toBeOkWith({
      status: "healthy",
      components: [{ name: "OrderDatabase", status: "healthy" }],
    });
  });

  it("reports the database unhealthy when it cannot answer", async ({ stub }) => {
    // GIVEN a client whose queries fail, as an unreachable server's would
    const db = prismaDatabase("OrderDatabase")({
      client: (adapter) => {
        const client = stub.client(connectionStringOf(adapter));
        client.breakQueries("connection refused");
        return client;
      },
    });
    const root = Module("Root")({
      imports: [db],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        silentLogger,
      ],
      exports: [db.port, HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN the report is unhealthy and carries the reason the driver gave
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [{ name: "OrderDatabase", status: "unhealthy", reason: "connection refused" }],
    });
  });

  it("offers its engine instrumentation rather than registering it", async ({ stub, observed }) => {
    // GIVEN the starter, which offers its instrumentation unconditionally now
    // that there is no arm to be on the wrong side of
    const db = prismaDatabase("OrderDatabase")({
      client: (adapter) => stub.client(connectionStringOf(adapter)),
    });
    const root = Module("Root")({
      imports: [db],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        silentLogger,
        ...observed.members.map((member) =>
          Provider.member(Observers)({ inject: {}, value: member }),
        ),
      ],
      exports: [db.port, Instrumentations],
    });

    // WHEN the contributions are collected and loaded, as an OTel SDK does
    const loaded = await Module.scoped(root, (ctx) =>
      fromSafePromise(
        Promise.all(ctx.get(Instrumentations).map((load) => load())).then((all) =>
          all.map((one) => one !== undefined),
        ),
      ),
    );

    // THEN one instrumentation is offered, and it loads because the optional
    // peer IS installed here — a graph composing no SDK never calls the
    // loader, which is what makes this a declaration rather than a side effect
    expect(loaded).toBeOkWith([true]);
  });
});
