# Testing an application

A spec boots the real composition root, on an ephemeral port, with an
environment it chooses, and stops it when the test ends. Install
`@btravstack/testing`, `vitest` and `@unthrown/vitest`, and register the
matchers once, at runtime in the vitest config and for the compiler in a
`src/vitest.d.ts`:

<!-- doctest: skip — a vitest config, not part of the application -->

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["@unthrown/vitest"] },
});
```

<!-- doctest: skip — an ambient declaration file, not part of the application -->

```ts
import type {} from "@unthrown/vitest";
```

## The application under test

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { HttpModule, defineHttp } from "@btravstack/orpc-server";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";
import { z } from "zod";

export class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

const GreetingModule = Module("Greeting")({
  provides: [
    Provider(Greeter)({ inject: {}, value: { greet: (name) => `Hello, ${name}!` } }),
  ],
  exports: [Greeter],
});

export const contract = {
  hello: oc.input(z.object({ name: z.string() })).output(z.object({ message: z.string() })),
};

const api = defineHttp();

export const App = HttpModule("App")({
  router: api.OrpcRouter(contract)({
    inject: { greeter: Greeter },
    sync: ({ greeter }) => ({
      hello: (_helpers, input) => OkAsync({ message: greeter.greet(input.name) }),
    }),
  }),
  imports: [GreetingModule],
});
```

## Fixtures

Put the extended `it` in one `test-fixtures.ts` beside the specs, and import
it instead of vitest's. `bootFixture` boots with signals off, no pre-drain
delay, and stops the application on every exit path, so a spec needs no
`try`/`finally`. A helper that reads the bound port keeps its guard here, out
of the test body.

```ts
import assert from "node:assert/strict";
import type { RunningApp } from "@btravstack/core";
import type { HttpInfo } from "@btravstack/http-server";
import { bootFixture } from "@btravstack/testing";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { test } from "vitest";

export const it = test.extend({
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),
});

export const clientOf = async <E>(
  app: RunningApp<E, HttpInfo>,
): Promise<RouterContractClient<typeof contract>> => {
  const info = (await app.runtimeInfo()).get();
  assert.ok(info !== undefined, "the runtime published no Serving.info");
  const client: RouterContractClient<typeof contract> = createORPCClient(
    new RPCLink({ origin: `http://127.0.0.1:${info.port}`, url: "/rpc" }),
  );
  return client;
};
```

A call's `env` **replaces** the fixture's rather than merging with it, so a
test that adds a variable restates `PORT` and `HOST` too.

## A booted spec

Every test body carries `// GIVEN`, `// WHEN`, `// THEN`, and asserts once,
deeply, on one resource. An assertion behind an `if` or a `?.` can decline to
run and still pass.

```ts
import { Provider } from "@btravstack/di";
import { createFakeClock, overridden } from "@btravstack/testing";
import { describe, expect } from "vitest";

describe("the greeting service", () => {
  it("greets over real HTTP", async ({ boot }) => {
    // GIVEN the real root, serving on an ephemeral port
    const client = await clientOf(boot(App));

    // WHEN the procedure is called through the contract's client
    const answer = client.hello({ name: "world" });

    // THEN it answers what the contract declares
    await expect(answer).resolves.toEqual({ message: "Hello, world!" });
  });

  it("greets with a substituted provider", async ({ boot }) => {
    // GIVEN the real root with only its Greeter replaced
    const client = await clientOf(
      boot(
        overridden(App, [
          Provider(Greeter)({ inject: {}, value: { greet: (name) => `Ahoy, ${name}!` } }),
        ]),
      ),
    );

    // WHEN the procedure is called
    const answer = client.hello({ name: "world" });

    // THEN the substitute answered
    await expect(answer).resolves.toEqual({ message: "Ahoy, world!" });
  });

  it("drains clean when idle", async ({ boot }) => {
    // GIVEN the application serving, on a clock the test owns, with the
    // production pre-drain delay restored
    const clock = createFakeClock();
    const app = boot(App, { clock, preDrainDelayMs: 5_000 });
    await app.runtimeInfo();

    // WHEN a drain is requested and the pre-drain delay is advanced
    app.requestDrain();
    await clock.advance(5_000);

    // THEN it exits clean, with nothing abandoned
    await expect(app.exited).resolves.toBeOkWith(
      expect.objectContaining({
        reason: "signal",
        drain: expect.objectContaining({ abandoned: 0 }),
      }),
    );
  });
});
```

`overridden` fails loudly when the root stops providing the port it replaces,
so a substitution cannot silently go stale. Time is never real in a test:
advance a fake clock instead of waiting.

## Going further

- Reading a running graph's services with `tapped`, and its log lines with a
  recording sink: <https://btravstack.github.io/btravstack/how-to/test-an-application>.
- Infrastructure: boot the real dependency with testcontainers, share one
  container, and isolate each test by the boundary it already has (a tenant, a
  vhost, a namespace), never by a server of its own.
- Temporal workers: <https://btravstack.github.io/btravstack/how-to/test-a-temporal-worker>.
