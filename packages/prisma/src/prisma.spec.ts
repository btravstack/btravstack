import { Env } from "@btravstack/config";
import { HealthChecks, Observers, runHealthChecks } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { prismaDatabase } from "./prisma.js";

const DATABASE_URL = "postgres://localhost:5432/orders";

describe("prismaDatabase", () => {
  it("opens the client against the URL the environment names", async ({ stub }) => {
    // GIVEN a starter over a stub client, and DATABASE_URL in the environment
    const db = prismaDatabase("OrderDatabase")({ client: stub.client });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ inject: {}, value: { DATABASE_URL } })],
      exports: [db.port],
    });

    // WHEN the scope is opened and the port resolved
    const url = await Module.scoped(root, (ctx) => OkAsync(ctx.get(db.port).url));

    // THEN the client was built with what the environment named
    expect(url).toBeOkWith(DATABASE_URL);
  });

  it("closes the pool when the scope closes", async ({ stub }) => {
    // GIVEN a graph holding the client open
    const db = prismaDatabase("OrderDatabase")({ client: stub.client });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ inject: {}, value: { DATABASE_URL } })],
      exports: [db.port],
    });

    // WHEN the scope opens and closes again
    await Module.scoped(root, (ctx) => OkAsync(ctx.get(db.port).url));

    // THEN the pool was released on the way out
    expect(stub.last()?.closed()).toBe(1);
  });

  it("reports a missing DATABASE_URL as a modeled error naming it", async ({ stub }) => {
    // GIVEN the same graph and an environment that names no database
    const db = prismaDatabase("OrderDatabase")({ client: stub.client });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ inject: {}, value: {} })],
      exports: [db.port],
    });

    // WHEN the scope is opened without DATABASE_URL
    const opened = await Module.scoped(root, (ctx) => OkAsync(ctx.get(db.port).url));

    // THEN it is an Err naming the variable, not a throw
    expect(opened).toBeErrWith(
      expect.objectContaining({ issues: [expect.objectContaining({ path: ["DATABASE_URL"] })] }),
    );
  });

  it("hands the client its own observing middleware, with no flag and no ports owed", async ({
    stub,
    observed,
  }) => {
    // GIVEN the starter in a root that owes it NOTHING beyond `Env` — the
    // observer is a set-port member, so composing one is the whole of what
    // makes the queries observed
    const db = prismaDatabase("OrderDatabase")({ client: stub.client });
    const root = Module("Root")({
      imports: [db],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL } }),
        ...observed.members.map((member) =>
          Provider.member(Observers)({ inject: {}, value: member }),
        ),
      ],
      exports: [db.port],
    });

    // WHEN a query the client ran reaches the middleware it was built with
    await Module.scoped(root, (ctx) => {
      const client = ctx.get(db.port);
      const hook = client.middleware[0];
      return OkAsync(hook?.afterQuery({}, { completed: true, rowCount: 2, latencyMs: 7 }, {}));
    });

    // THEN it was observed — the client was constructed with the hook without
    // anyone asking, and the runtime's own measurements ride the DETAILS,
    // where an unbounded value belongs
    expect(observed.taken()).toEqual([
      expect.objectContaining({
        component: "database",
        name: "query",
        outcome: "ok",
        attributes: { source: "driver" },
        details: { rows: 2, latencyMs: 7 },
      }),
    ]);
  });

  it("declares a health check that asks the database to answer", async ({ stub }) => {
    // GIVEN a starter over a reachable stub client
    const db = prismaDatabase("OrderDatabase")({ client: stub.client });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ inject: {}, value: { DATABASE_URL } })],
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

  it("probes with a statement the server has to run, decoding no rows", async ({ stub }) => {
    // GIVEN a starter over a reachable stub client
    const db = prismaDatabase("OrderDatabase")({ client: stub.client });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ inject: {}, value: { DATABASE_URL } })],
      exports: [db.port, HealthChecks],
    });

    // WHEN the contributed check is run
    await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN it went out as an `affectedCount` plan: the statement still runs, so
    // a pool whose server is gone cannot answer it, and nothing decodes a row —
    // which is what keeps the probe off any codec the contract may not register
    expect(stub.last()?.ran()).toEqual([
      { sql: "SELECT 1", values: [], kind: "affectedCount", tx: undefined },
    ]);
  });

  it("reports the database unhealthy when it cannot answer", async ({ stub }) => {
    // GIVEN a client whose queries fail, as an unreachable server's would
    const db = prismaDatabase("OrderDatabase")({
      client: (binding) => {
        const client = stub.client(binding);
        client.breakQueries("connection refused");
        return client;
      },
    });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ inject: {}, value: { DATABASE_URL } })],
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

  it("names the database unreachable when the driver rejected with no message", async ({
    stub,
  }) => {
    // GIVEN a driver that rejects with something that is not an `Error` — which
    // nothing obliges it not to do, and which leaves the check with no message
    // to pass on
    const db = prismaDatabase("OrderDatabase")({
      client: (binding) => {
        const client = stub.client(binding);
        client.breakQueriesWith({ code: "57P01" });
        return client;
      },
    });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ inject: {}, value: { DATABASE_URL } })],
      exports: [db.port, HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN the component is still named and still unhealthy, with the fallback
    // reason rather than `[object Object]` or an empty string
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [{ name: "OrderDatabase", status: "unhealthy", reason: "database unreachable" }],
    });
  });
});
