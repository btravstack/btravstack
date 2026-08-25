---
title: Configure and test
description: Bind a setting of your own from the environment, then prove it with a booted test — an ephemeral port, a typed client, and a fake clock for the drain.
---

# Configure and test

> **Tutorial.** The second hands-on lesson. It assumes you finished
> [Getting started](/tutorial/getting-started) and have `greeter.ts`,
> `contract.ts`, `router.ts`, `app.ts` and `main.ts` from it. We keep
> explanation to a minimum here and link out to it.

By the end, the greeting word will come from the environment the way `PORT`
already does — validated once, as the graph is built — and a test will boot
the real application on an ephemeral port, call it through the typed client,
and drain it on a clock that never actually waits.

## Step 1 — Install the test harness

::: code-group

```sh [pnpm]
pnpm add -D @btravstack/testing vitest @unthrown/vitest
```

```sh [npm]
npm install -D @btravstack/testing vitest @unthrown/vitest
```

```sh [yarn]
yarn add -D @btravstack/testing vitest @unthrown/vitest
```

:::

Configuration needs nothing new: `Config` lives in `@btravstack/config`, which
you installed in lesson one.

## Step 2 — Bind a setting of your own

Lesson one hard-coded `Hello`. Make it a setting: `Config.provider` mints a
port and binds it from the `Env` port the kernel provides, validating **once,
as the graph is built** — your code never touches `process.env`:

```ts
// greeter.ts
import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";

const greetingConfig = Config.provider("GreetingConfig")(
  Config.object({
    greeting: Config.string("GREETING", { default: "Hello" }),
  }),
);

export class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

export const GreetingModule = Module("Greeting")({
  needs: [Env],
  provides: [
    greetingConfig,
    Provider(Greeter)(
      { config: greetingConfig.port },
      {
        sync: ({ config }) => ({
          greet: (name) => `${config.greeting}, ${name}!`,
        }),
      },
    ),
  ],
  exports: [Greeter],
});
```

Three changes from lesson one. `greetingConfig` is a provider whose port
carries `{ greeting: string }`; the `Greeter` provider now declares it as a
dependency and closes over the value; and the module says `needs: [Env]`
out loud — its providers read the environment port, and nothing inside the
module supplies it. The kernel does, to every graph it boots
([the rule](/reference/di/modules)).

Nothing else changes: `router.ts`, `app.ts` and `main.ts` still compile,
because the module's exports did not move. Run it:

```sh
GREETING=Ahoy PORT=3000 node src/main.ts
```

and `client.ts` from lesson one now prints `Ahoy, world!`. Try
`GREETING=""` too: an empty variable is a configuration **error**, not an
absent one — the process prints a `startFailed` event naming `GREETING` and
exits `78` ([why](/reference/config)).

## Step 3 — Register the matchers

One config file, once. `@unthrown/vitest` registers `Result` matchers
(`toBeOkWith`, `toBeErrTagged`, …) as a vitest setup file, so a test asserts
on a `Result` in one deep `expect`:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["@unthrown/vitest"] },
});
```

## Step 4 — Boot the application in a test

`@btravstack/testing`'s `bootFixture` is `start` in test shape: it boots the
real module — the same `App` — with `signals` off and an environment you
choose, and stops it when the test ends, on every path. `PORT=0` asks the
operating system for an ephemeral port, so tests never collide:

<!-- doctest: isolate
// The application as this lesson leaves it, restated so the spec compiles
// on its own — in your project these come from the files above.
import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import { HttpModule, defineHttp } from "@btravstack/http-server";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";
import { z } from "zod";
import type {} from "@unthrown/vitest";

class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}
const greetingConfig = Config.provider("GreetingConfig")(
  Config.object({ greeting: Config.string("GREETING", { default: "Hello" }) }),
);
const GreetingModule = Module("Greeting")({
  needs: [Env],
  provides: [
    greetingConfig,
    Provider(Greeter)(
      { config: greetingConfig.port },
      { sync: ({ config }) => ({ greet: (name) => `${config.greeting}, ${name}!` }) },
    ),
  ],
  exports: [Greeter],
});
const contract = {
  hello: oc
    .input(z.object({ name: z.string() }))
    .output(z.object({ message: z.string() })),
};
const api = defineHttp();
const greetingRouter = api.HttpRouter(contract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      hello: (_helpers, input) => OkAsync({ message: greeter.greet(input.name) }),
    }),
  },
);
const App = HttpModule("App")({ router: greetingRouter, imports: [GreetingModule] });
-->

```ts
// app.spec.ts
import assert from "node:assert/strict";

import { bootFixture } from "@btravstack/testing";
import { describe, expect, test } from "vitest";

import { App } from "./app.js";

const it = test.extend({
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),
});

describe("the greeting service", () => {
  it("serves the configured greeting", async ({ boot }) => {
    // GIVEN the real application, with this test's own environment
    const app = boot(App, { env: { GREETING: "Ahoy" } });
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");

    // WHEN the procedure is called over real HTTP
    const response = await fetch(`http://127.0.0.1:${info.port}/rpc/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { name: "world" } }),
    });

    // THEN the greeting came from the environment, not the code
    await expect(response.json()).resolves.toEqual({
      json: { message: "Ahoy, world!" },
    });
  });
});
```

Run it:

```sh
npx vitest run
```

Two things to notice. The test booted the **whole** application — the graph,
the config validation, the HTTP listener — not a handler in isolation; and
`runtimeInfo()` is how it learned the port the runtime actually bound,
published once the process is serving — `get()` plus an assertion is the
shape, since its error channel is empty and `undefined` only means the
runtime never reached serving, which deserves a named failure rather than a
confusing fetch error. The raw `fetch` shows there is no
magic; in your own suite, hand the origin to lesson one's typed client
instead.

## Step 5 — Drain it on a fake clock

Lesson one stopped the process with a signal and a real five-second wait. A
test stops it with a method — and a clock it controls, so the wait costs
nothing:

<!-- doctest: isolate
// The application as this lesson leaves it, restated so the spec compiles
// on its own — in your project these come from the files above.
import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import { HttpModule, defineHttp } from "@btravstack/http-server";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";
import { z } from "zod";
import type {} from "@unthrown/vitest";

class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}
const greetingConfig = Config.provider("GreetingConfig")(
  Config.object({ greeting: Config.string("GREETING", { default: "Hello" }) }),
);
const GreetingModule = Module("Greeting")({
  needs: [Env],
  provides: [
    greetingConfig,
    Provider(Greeter)(
      { config: greetingConfig.port },
      { sync: ({ config }) => ({ greet: (name) => `${config.greeting}, ${name}!` }) },
    ),
  ],
  exports: [Greeter],
});
const contract = {
  hello: oc
    .input(z.object({ name: z.string() }))
    .output(z.object({ message: z.string() })),
};
const api = defineHttp();
const greetingRouter = api.HttpRouter(contract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      hello: (_helpers, input) => OkAsync({ message: greeter.greet(input.name) }),
    }),
  },
);
const App = HttpModule("App")({ router: greetingRouter, imports: [GreetingModule] });
-->

```ts
// drain.spec.ts
import { bootFixture, createFakeClock } from "@btravstack/testing";
import { expect, test } from "vitest";

import { App } from "./app.js";

const it = test.extend({
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),
});

it("drains clean when idle", async ({ boot }) => {
  // GIVEN the application serving, on a clock this test owns
  const clock = createFakeClock();
  const app = boot(App, { clock });
  await app.runtimeInfo();

  // WHEN it is asked to drain and the pre-drain delay is advanced, not waited
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
```

`requestDrain()` takes the same path SIGTERM does — readiness flips, the
kernel waits `preDrainDelayMs`, in-flight work gets its window — but the wait
happened on `clock.advance(5_000)`, which resolves immediately. A kernel whose
own tests are slow gets tested badly, so timing is never real in a test
([Test an application](/how-to/test-an-application)).

## What you now have

```
src/greeter.ts     GreetingModule — reads GREETING inside the graph
src/app.spec.ts    boots the real App on port 0, asserts through real HTTP
src/drain.spec.ts  drains it on a fake clock, asserts the exit report
```

The application still has one composition root and one entry point; what grew
is the proof around it.

## Where next

- [Protect the API](/tutorial/protect-the-api) — the next lesson: mark a
  procedure, declare a scheme, read the principal.
- [Configure from the environment](/how-to/configure-from-the-environment) —
  every field type, pinning, and bringing your own Standard Schema.
- [Test an application](/how-to/test-an-application) — taps, recording sinks,
  and the tenant-per-test pattern the examples use.
