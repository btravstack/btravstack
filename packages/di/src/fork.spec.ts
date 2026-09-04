import { Ok, OkAsync } from "unthrown";
import { expect, test } from "vitest";

import { Context, Module, Port, Provider } from "./index.js";

class Pool extends Port("FPool")<{ readonly id: string }> {}
class Txn extends Port("FTxn")<{ readonly id: string }> {}

test("a fork releases only its own resources and leaves the parent up", async () => {
  const released: string[] = [];
  const app = Module("App")({
    provides: [
      Provider(Pool)({
        inject: {},
        acquire: () => Ok({ id: "pool" }),
        release: () => void released.push("pool"),
      }),
    ],
    exports: [Pool],
  });
  const request = Module("Request")({
    // The fork seam, stated: `Pool` comes from the parent scope this request
    // module is forked from, never from inside it.
    needs: [Pool],
    provides: [
      Provider(Txn)({
        inject: { pool: Pool },
        acquire: ({ pool }) => Ok({ id: `txn-on-${pool.id}` }),
        release: () => void released.push("txn"),
      }),
    ],
    exports: [Txn],
  });

  const outcome = await Module.scoped(app, (appCtx) =>
    Module.forkScope(appCtx, request, (ctx) => OkAsync(ctx.get(Txn).id))
      // Checkpoint after the first fork unwinds: only its own "txn" release
      // has run — the parent's "pool" is still absent, proving the parent
      // stayed up across the fork's own teardown.
      .tap(() => void expect(released).toEqual(["txn"]))
      .flatMap((first) =>
        Module.forkScope(appCtx, request, (ctx) => OkAsync(ctx.get(Txn).id))
          // Checkpoint after the second, sibling fork unwinds: a second
          // "txn" release, still no "pool" — the parent survives a second
          // fork over the same context too, not just the first.
          .tap(() => void expect(released).toEqual(["txn", "txn"]))
          .map((second) => [first, second] as const),
      ),
  );

  expect(outcome).toBeOk();
  expect(released).toEqual(["txn", "txn", "pool"]);
});

test("builds a forked module over a seeded value the parent never provided", async () => {
  // GIVEN a parent with no principal, and a unit module that needs one
  class Principal extends Port("SeedPrincipal")<{ readonly userId: string }> {}
  class Greeting extends Port("SeedGreeting")<{ readonly text: string }> {}
  const Unit = Module("SeedUnit")({
    needs: [Principal],
    provides: [
      Provider(Greeting)({
        inject: { principal: Principal },
        sync: ({ principal }) => ({ text: `hello ${principal.userId}` }),
      }),
    ],
    exports: [Greeting],
  });
  const parent = Context.empty();

  // WHEN the fork is seeded with a principal
  const greeting = Module.forkScope(parent, Unit, (ctx) => OkAsync(ctx.get(Greeting).text), {
    seed: [[Principal, { userId: "ada" }]],
  });

  // THEN the module was built over it
  await expect(greeting).toBeOkWith("hello ada");
});
