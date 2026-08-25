import { Env } from "@btravstack/config";
import { Logger, Meter, Tracer } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { OkAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { prismaDatabase } from "./prisma.js";

describe("prismaDatabase", () => {
  it("opens the client against the URL the environment names", async ({ stub }) => {
    // GIVEN a starter over a stub client, and DATABASE_URL in the environment
    const db = prismaDatabase("OrderDatabase")({
      client: (_, url) => stub.client(url),
      instrumented: false,
    });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ value: { DATABASE_URL: "postgres://localhost:5432/orders" } })],
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
      client: (_, url) => stub.client(url),
      instrumented: false,
    });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ value: { DATABASE_URL: "postgres://localhost:5432/orders" } })],
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
      client: (_, url) => stub.client(url),
      instrumented: false,
    });
    const root = Module("Root")({
      imports: [db],
      provides: [Provider(Env)({ value: {} })],
      exports: [db.port],
    });

    // WHEN the scope is opened without DATABASE_URL
    const opened = await Module.scoped(root, (ctx) => OkAsync(ctx.get(db.port).url));

    // THEN it is an Err naming the variable, not a throw
    expect(opened).toBeErrWith(
      expect.objectContaining({ issues: [expect.objectContaining({ path: ["DATABASE_URL"] })] }),
    );
  });

  it("instruments by default, so a query through the graph is recorded", async ({
    stub,
    telemetry,
  }) => {
    // GIVEN the starter with no `instrumented` flag at all, in a root that
    // supplies the three telemetry ports the default arm now depends on
    const db = prismaDatabase("OrderDatabase")({ client: (_, url) => stub.client(url) });
    const root = Module("Root")({
      imports: [db],
      provides: [
        Provider(Env)({ value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        Provider(Logger)({ value: telemetry.logger }),
        Provider(Tracer)({ value: telemetry.tracer }),
        Provider(Meter)({ value: telemetry.meter }),
      ],
      exports: [db.port],
    });

    // WHEN a query runs against the client the graph handed back
    await Module.scoped(root, (ctx) =>
      fromSafePromise(ctx.get(db.port).query("Order", "findMany", Promise.resolve([]))),
    );

    // THEN it was spanned — the client came out wrapped without anyone asking
    expect(telemetry.recorded().spans).toEqual([
      expect.objectContaining({ name: "db.Order.findMany" }),
    ]);
  });
});
