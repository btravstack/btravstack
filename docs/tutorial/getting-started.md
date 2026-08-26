---
title: Getting started
description: Boot a small oRPC service with @btravstack/core and @btravstack/http-server, call it with a typed client, then watch it drain on SIGTERM.
---

# Getting started

> **Tutorial.** A hands-on first lesson. Follow it top to bottom and you will
> have written, booted, called and stopped an HTTP service on the kernel. We
> keep explanation to a minimum here and link out to it — the goal is to _do_,
> not to study.

By the end you will have a process that serves one oRPC procedure, reads its
port from the environment inside the graph, and drains cleanly when it is told
to stop. It takes about ten minutes.

## Step 1 — Install

::: code-group

```sh [pnpm]
pnpm add @btravstack/core @btravstack/http-server @btravstack/config @btravstack/di unthrown @orpc/server @orpc/contract @unthrown/orpc zod
```

```sh [npm]
npm install @btravstack/core @btravstack/http-server @btravstack/config @btravstack/di unthrown @orpc/server @orpc/contract @unthrown/orpc zod
```

```sh [yarn]
yarn add @btravstack/core @btravstack/http-server @btravstack/config @btravstack/di unthrown @orpc/server @orpc/contract @unthrown/orpc zod
```

:::

Every one of those but `zod` is a **peer** of `@btravstack/http-server`, so your
application holds a single copy of each ([why](/explanation/peer-dependencies)). The
project needs `"type": "module"` in its `package.json` — `main.ts` ends in a
top-level `await` — TypeScript in `strict` mode, and Node `>=20`.

## Step 2 — Declare a service

A service is a **port** — a name with a service type — and a **provider** that
builds it. Both live in a **module**, which says what it provides and what it
lets others see:

**`greeter.ts`**

```ts
import { Module, Port, Provider } from "@btravstack/di";

export class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

export const GreetingModule = Module("Greeting")({
  provides: [
    Provider(Greeter)({ value: { greet: (name) => `Hello, ${name}!` } }),
  ],
  exports: [Greeter],
});
```

Nothing here knows about HTTP. That is the point: the module is the
application, and a runtime is something you compose _around_ it in Step 5.

## Step 3 — Write the contract

The transport speaks a contract, declared before any implementation exists. One
procedure, `hello`, with a typed input and output:

**`contract.ts`**

```ts
import { oc } from "@orpc/contract";
import { z } from "zod";

export const contract = {
  hello: oc
    .input(z.object({ name: z.string() }))
    .output(z.object({ message: z.string() })),
};
```

`oc` is oRPC's contract builder, and the schemas are **validated at the
boundary**: a client that posts `{ name: 42 }` is rejected before `hello` runs.
Reach for oRPC's `type<T>()` only where you genuinely trust a shape without
checking it — it validates nothing, so an unchecked input arrives typed as
whatever the contract claimed. A client can import this file and call the
service without the server's code — which is why it is its own file.

## Step 4 — Implement the contract as a router

The router is a provider like any other: it declares the services its
procedures call, and di builds it from them. Every HTTP entity comes from
**one** `defineHttp` call — the door where an application declares its
security schemes; this service is public, so it takes no argument. Then
`api.HttpRouter(contract)` types the implementation from the contract — a
typo'd key or a wrong output is a compile error here:

**`router.ts`**

```ts
import { defineHttp } from "@btravstack/http-server";
import { OkAsync } from "unthrown";

import { contract } from "./contract.js";
import { Greeter } from "./greeter.js";

// Held whole and never destructured: each destructured member expands to a
// type mentioning an inaccessible `unique symbol` (TS2527).
const api = defineHttp();

export const greetingRouter = api.HttpRouter(contract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      hello: (_helpers, input) =>
        OkAsync({ message: greeter.greet(input.name) }),
    }),
  },
);
```

Each leaf is a plain function returning a `Result`. `OkAsync` is the success
case; a declared error would be returned as an `Err` from the `helpers.errors`
map, and the client would receive it typed. Nothing is thrown, and no `os.…`
or `implement(...)` is spelled — the starter does that.

## Step 5 — Compose the application

`HttpModule(name)({...})` is a di `Module(name)({...})` that also takes the
router. Under the hood it imports the HTTP starter, provides the router and
exports `HttpRuntime` — the one port the kernel resolves and drives:

**`app.ts`**

```ts
import { HttpModule } from "@btravstack/http-server";

import { GreetingModule } from "./greeter.js";
import { greetingRouter } from "./router.js";

export const App = HttpModule("App")({
  router: greetingRouter,
  imports: [GreetingModule],
});
```

Try deleting `imports: [GreetingModule]` and watch the call fail to compile:
the router's provider declares `Greeter`, and nothing supplies it. That is
di's gate ([Compile errors, not surprises](/explanation/compile-time-wiring)),
and it fires before any process exists.

## Step 6 — Write `main.ts`

**`main.ts`**

```ts
import { runMain } from "@btravstack/core";

import { App } from "./app.js";

await runMain(App);
```

That is the whole entry point. `runMain` builds the graph, resolves
`HttpRuntime`, serves it, waits for the process to exit and sets
`process.exitCode` — `0` clean, `78` for a bad configuration variable, `2` for
a drain that abandoned work. It never calls `process.exit`
([why](/explanation/nothing-throws)).

## Step 7 — Run it

```sh
PORT=3000 node src/main.ts
```

Node `>=22.18` runs a `.ts` entry point directly by stripping the types; on an
older Node, `npx tsx src/main.ts` does the same. On stderr, one JSON line per
kernel event:

```json
{"type":"building"}
{"type":"serving","runtime":"http"}
```

`PORT` was read _inside_ the graph — the starter binds `PORT` (default `3000`)
and `HOST` (default `0.0.0.0`) onto a `HttpConfig` port from the `Env` port the
kernel provides. Try `PORT=abc` instead: the process prints a `startFailed`
event naming the variable and exits `78`, without your code having parsed
anything.

## Step 8 — Call it

The contract types the client too. `RPCLink` speaks oRPC's RPC protocol to the
endpoint the starter mounted under `/rpc`:

**`client.ts`**

```ts
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";

import { contract } from "./contract.js";

const client: RouterContractClient<typeof contract> = createORPCClient(
  new RPCLink({ origin: "http://localhost:3000", url: "/rpc" }),
);

const { message } = await client.hello({ name: "world" });
console.log(message); // Hello, world!
```

```sh
node src/client.ts
```

`client.hello` takes `{ name: string }` and returns `{ message: string }`
because the contract says so — the router file was never imported.

::: tip A `Result` client
`@unthrown/orpc/client`'s `createResultClient` wraps this client so every call
returns an `AsyncResult` whose error channel is the contract's declared
errors — the shape `examples/order-api` uses. See
[Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http).
:::

## Step 9 — Stop it

Send the process a SIGTERM (Ctrl-C sends SIGINT, which takes the same path):

```sh
kill -TERM <pid>
```

Then read stderr:

```json
{"type":"draining","inFlight":0}
{"type":"drained","report":{"inFlightAtStart":0,"completed":0,"abandoned":0}}
{"type":"stopping"}
{"type":"exited"}
```

Between `draining` and `drained`, three things happened in order: readiness
flipped false, the kernel waited five seconds **before** telling the runtime to
stop accepting, and in-flight requests were given twenty seconds to finish.
The wait is deliberate — Kubernetes removes a pod from its endpoints
eventually, not instantly, so a process that stops accepting the moment SIGTERM
lands rejects traffic still being routed to it. The whole argument is in
[Draining, in three beats](/explanation/draining-in-three-beats); the two
numbers are `preDrainDelayMs` and `drainTimeoutMs` on
[`StartOptions`](/reference/core/start).

## Where next

- [Configure and test](/tutorial/configure-and-test) — the next lesson: bind
  a setting of your own the way the starter binds `PORT`, then prove it with
  a booted test.
- [Log and correlate](/how-to/log-and-correlate) — `observability()` next to
  the starter, and the kernel events above as lines in the same stream.
- [Why btravstack?](/explanation/why-btravstack) — the theses this lesson quietly
  followed.
