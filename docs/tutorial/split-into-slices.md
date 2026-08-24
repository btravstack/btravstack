---
title: Split into slices
description: Two contract fragments, two controllers, two modules that own their piece — composed by a keyed router that refuses a key the contract never declared.
---

# Split into slices

> **Tutorial.** The fourth hands-on lesson. It assumes you finished
> [Protect the API](/tutorial/protect-the-api) and have the marked contract,
> `auth.ts` and the router from it. We keep explanation to a minimum here and
> link out to it.

By the end, the service will have two verticals — greetings and farewells —
each owning its piece of the contract, its controller and its dependencies,
composed by a root that is a list of slices. The router becomes **keyed**: one
entry per contract fragment, and a key the contract does not declare refuses
to compile. This is the shape an application keeps as it grows, and the reason
composing slices is a starting point rather than a trap.

## Step 1 — Split the contract into fragments

No new install. Group the existing procedures under a `greetings` key and add
a `farewells` fragment beside it:

<!-- doctest: prelude
// The application as lesson three left it, restated so this page compiles on
// its own: the configurable Greeter, its module, and auth.ts's one
// defineHttp — none of which this lesson changes.
import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import { HttpAuthenticator, Unauthenticated, defineHttp } from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";

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

type Identity = { readonly name: string };
const userAuth = HttpAuthenticator<Identity>()({
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const name = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    return name === "" ? ErrAsync(new Unauthenticated()) : OkAsync({ name });
  },
});
const api = defineHttp({ authenticators: { user: userAuth } });
-->

```ts
// contract.ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const greetings = {
  hello: oc
    .input(z.object({ name: z.string() }))
    .output(z.object({ message: z.string() })),
  greetMe: authenticated({ user: [] })(
    oc.output(z.object({ message: z.string() })),
  ),
};

const farewells = {
  goodbye: oc
    .input(z.object({ name: z.string() }))
    .output(z.object({ message: z.string() })),
};

export const contract = { greetings, farewells };
```

A fragment is itself a valid contract — a client can import `contract.farewells`
alone — which is what lets a slice lift out into its own process later without
its controller changing ([the property](/reference/http)).

## Step 2 — A controller per fragment

`api.HttpController(name, fragment)` is `api.HttpRouter`'s slice-sized form:
the same deps record, the same `sync` arm, typed by **one fragment** — and it
mints a port for the piece it builds, so there is no class to name:

```ts
// slices/greetings/controller.ts
import { OkAsync } from "unthrown";

import { api } from "../../auth.js";
import { contract } from "../../contract.js";
import { Greeter } from "../../greeter.js";

export const greetingsController = api.HttpController(
  "GreetingsController",
  contract.greetings,
)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      hello: (_helpers, input) =>
        OkAsync({ message: greeter.greet(input.name) }),
      greetMe: ({ context }) =>
        OkAsync({ message: greeter.greet(context.principal.name) }),
    }),
  },
);
```

```ts
// slices/farewells/controller.ts
import { OkAsync } from "unthrown";

import { api } from "../../auth.js";
import { contract } from "../../contract.js";
import { Greeter } from "../../greeter.js";

export const farewellsController = api.HttpController(
  "FarewellsController",
  contract.farewells,
)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      goodbye: (_helpers, input) =>
        OkAsync({ message: `${greeter.greet(input.name)} And goodbye.` }),
    }),
  },
);
```

The bodies moved, unchanged, out of `router.ts`. `greetMe`'s principal is
still typed — the fragment carries its mark with it.

## Step 3 — A module per slice

Each slice ships as an ordinary di module that provides its controller and
exports it — and states, out loud, where its dependencies come from. Two
shapes, both legitimate:

```ts
// slices/greetings/module.ts
import { Module } from "@btravstack/di";

import { GreetingModule } from "../../greeter.js";
import { greetingsController } from "./controller.js";

export const GreetingsSlice = Module("GreetingsSlice")({
  imports: [GreetingModule],
  provides: [greetingsController],
  exports: [greetingsController],
});
```

```ts
// slices/farewells/module.ts
import { Module } from "@btravstack/di";

import { Greeter } from "../../greeter.js";
import { farewellsController } from "./controller.js";

export const FarewellsSlice = Module("FarewellsSlice")({
  // "Some root supplies this": the slice has no vertical of its own, so it
  // names what it expects instead of importing one.
  needs: [Greeter],
  provides: [farewellsController],
  exports: [farewellsController],
});
```

`GreetingsSlice` **imports** the vertical it owns. `FarewellsSlice` owns none
— it borrows `Greeter` — so it declares the need instead; leave `needs` off
and the `Module(...)` call refuses to compile, naming the port
([di's `NeedsGate`](/reference/di/modules)). Either way, a slice directory is
readable on its own: which ports come from outside, without naming who
supplies them.

## Step 4 — The keyed router and the new root

The router composes the controllers under the **contract's own keys**, exact
against it. The root becomes a list of slices, plus what no slice owns:

```ts
// app.ts
import { HttpModule } from "@btravstack/http";

import { api } from "./auth.js";
import { contract } from "./contract.js";
import { GreetingModule } from "./greeter.js";
import { farewellsController } from "./slices/farewells/controller.js";
import { FarewellsSlice } from "./slices/farewells/module.js";
import { greetingsController } from "./slices/greetings/controller.js";
import { GreetingsSlice } from "./slices/greetings/module.js";

export const greetingRouter = api.HttpRouter(contract)({
  greetings: greetingsController,
  farewells: farewellsController,
});

export const App = HttpModule("App")({
  router: greetingRouter,
  // GreetingModule appears twice in the tree — here, and inside
  // GreetingsSlice. di dedupes by provider reference, so the diamond builds
  // ONE Greeter — and this root-level import is what discharges
  // FarewellsSlice's declared need.
  imports: [GreetingsSlice, FarewellsSlice, GreetingModule],
});
```

Delete `router.ts` — its job moved into the slices. `main.ts` has not changed
since lesson one.

The keyed form is exact both ways. Every fragment must be covered, and a key
the contract never declared is refused **by name**:

```ts
api.HttpRouter(contract)({
  greetings: greetingsController,
  farewells: farewellsController,
  // @ts-expect-error — UNDECLARED KEY: the contract declares no fragment under `ceremonies`.
  ceremonies: farewellsController,
});
```

## Step 5 — Run it

```sh
GREETING=Ahoy PORT=3000 node src/main.ts
```

```sh
curl -X POST http://localhost:3000/rpc/greetings/hello \
  -H 'content-type: application/json' -d '{"json":{"name":"world"}}'
curl -X POST http://localhost:3000/rpc/farewells/goodbye \
  -H 'content-type: application/json' -d '{"json":{"name":"world"}}'
```

The fragment keys became path segments — the contract's shape is the API's
shape. `greetMe` still wants its bearer, exactly as in lesson three.

## What you now have

```
src/contract.ts                     two fragments under one contract
src/auth.ts                         unchanged since lesson three
src/slices/greetings/controller.ts  the fragment's implementation
src/slices/greetings/module.ts      imports its vertical
src/slices/farewells/controller.ts  the other fragment's implementation
src/slices/farewells/module.ts      declares its need instead
src/app.ts                          keyed router + a list of slices
```

Growing the application is now additive: a new vertical is a new fragment, a
new slice directory, and two lines in `app.ts`. The examples run this shape at
full size — [Order API](/examples/order-api) is the same anatomy with a
database behind it.

## Where next

- [The same application, a second runtime](/tutorial/second-runtime) — the
  finale: boot `GreetingModule` under a Temporal worker.
- [Split a router into controllers](/how-to/split-a-router-into-controllers) —
  the recipe, including lifting a slice into its own process.
- [Modules and privacy](/explanation/modules-and-privacy) — why a slice's
  internals stay invisible, and what `exports` actually withholds.
