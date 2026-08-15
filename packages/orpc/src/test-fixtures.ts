import assert from "node:assert/strict";

import { start, type RunningApp } from "@btravstack/core";
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { HttpHandler, HttpRuntime, http, type HttpInfo } from "@btravstack/http";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { os, type RouterClient } from "@orpc/server";
import { expect, test } from "vitest";

import { orpc } from "./orpc.js";

/** A greeting service, so the router has a real dependency to declare. */
class Greeter extends Port("Greeter")<{ readonly greet: (name: string) => string }> {}

const routerOf = (greeter: ServiceOf<Greeter>) =>
  os.router({
    hello: os.handler(() => greeter.greet("world")),
    boom: os.handler(() => {
      // oxlint-disable-next-line unthrown/no-throw -- the defect IS the subject under test: oRPC's own collapse to INTERNAL_SERVER_ERROR
      throw new Error("bug");
    }),
  });

/** The router as a service, built from the greeter it declares. */
class GreetingRouter extends Port("GreetingRouter")<ReturnType<typeof routerOf>> {}

const app = (prefix?: `/${string}`) =>
  Module("App")({
    imports: [http({ port: 0, hostname: "127.0.0.1" })],
    provides: [
      Provider(Greeter)({ value: { greet: (name) => `hello ${name}` } }),
      Provider(GreetingRouter)([Greeter], { sync: (greeter) => routerOf(greeter) }),
      orpc(GreetingRouter, prefix === undefined ? {} : { prefix }),
    ],
    exports: [HttpRuntime, HttpHandler],
  });

export type OrpcFixtures = {
  /** Starts the app on an ephemeral port and registers its shutdown; hands back its origin and a typed client. */
  readonly serve: (prefix?: `/${string}`) => Promise<{
    readonly origin: string;
    readonly client: RouterClient<ReturnType<typeof routerOf>>;
  }>;
};

export const it = test.extend<OrpcFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serve: async ({}, use) => {
    const started: RunningApp<never, HttpInfo>[] = [];

    await use(async (prefix) => {
      const running = start(app(prefix), {
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
      });
      started.push(running);
      const info = (await running.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      const client: RouterClient<ReturnType<typeof routerOf>> = createORPCClient(
        new RPCLink({ origin, url: prefix ?? "/rpc" }),
      );
      return { origin, client };
    });

    for (const running of started) {
      running.stop();
      await expect(running.exited).toBeOk();
    }
  },
});
