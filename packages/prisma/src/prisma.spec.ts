import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { prismaDatabase } from "./prisma.js";

describe("prismaDatabase", () => {
  it("opens the client against the URL the environment names", async ({ stub }) => {
    // GIVEN a starter over a stub client, and DATABASE_URL in the environment
    const db = prismaDatabase("OrderDatabase")({ client: (_, url) => stub.client(url) });
    const root = Module("Root")({
      provides: [
        Provider(Env)({ value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        db.config,
        db.provider,
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
    const db = prismaDatabase("OrderDatabase")({ client: (_, url) => stub.client(url) });
    const root = Module("Root")({
      provides: [
        Provider(Env)({ value: { DATABASE_URL: "postgres://localhost:5432/orders" } }),
        db.config,
        db.provider,
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
    const db = prismaDatabase("OrderDatabase")({ client: (_, url) => stub.client(url) });
    const root = Module("Root")({
      provides: [Provider(Env)({ value: {} }), db.config, db.provider],
      exports: [db.port],
    });

    // WHEN the scope is opened without DATABASE_URL
    const opened = await Module.scoped(root, (ctx) => OkAsync(ctx.get(db.port).url));

    // THEN it is an Err naming the variable, not a throw
    expect(opened).toBeErrWith(
      expect.objectContaining({ issues: [expect.objectContaining({ path: ["DATABASE_URL"] })] }),
    );
  });
});
