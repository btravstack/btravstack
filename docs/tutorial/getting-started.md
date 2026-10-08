---
title: Getting started
description: Boot a small oRPC service with @btravstack/core and @btravstack/orpc-server, call it with a typed client, then watch it drain on SIGTERM.
---

# Getting started

> **Tutorial.** A hands-on first lesson. Follow it top to bottom and you will
> have written, booted, called and stopped an HTTP service on the kernel. We
> keep explanation to a minimum here and link out to it — the goal is to _do_,
> not to study.

By the end you will have a process that serves one oRPC procedure, reads its
port from the environment inside the graph, and drains cleanly when it is told
to stop. It takes about ten minutes.

::: tip Only need one library?
[entity](/entity/) and [di](/di/) each have a standalone guide. This tutorial
builds an HTTP application with the full framework.
:::

## Step 1 — Create the project

You need Node `>=22.12`. Make an empty directory; by the end of the lesson it will
hold this:

```text
hello-btravstack/
├── package.json
├── tsconfig.json
└── src/
    ├── greeter.ts
    ├── contract.ts
    ├── router.ts
    ├── app.ts
    ├── main.ts
    └── client.ts
```

Start with the two files at the top.

**`package.json`**

```json
{
  "name": "hello-btravstack",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc",
    "start": "tsx src/main.ts",
    "client": "tsx src/client.ts"
  }
}
```

`"type": "module"` makes the project ESM, which `main.ts` needs for its
top-level `await`.

**`tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`moduleResolution: "nodenext"` is why every relative import below carries a
`.js` suffix. `noEmit` makes `tsc` a check and nothing else — `tsx` runs the
code — so `typecheck` is the command that tells you whether the wiring holds.
The lesson runs each script as `npm run …`; `pnpm …` and `yarn …` run the same
ones.

Then install, from the same directory:

::: code-group

```sh [pnpm]
pnpm add @btravstack/core @btravstack/http-server @btravstack/orpc-server \
  @btravstack/htmx-server @btravstack/config @btravstack/di \
  @btravstack/contract unthrown @unthrown/orpc@^0.2.0 zod \
  @orpc/server@2.0.0-beta.28 @orpc/contract@2.0.0-beta.28 @orpc/client@2.0.0-beta.28 \
  @orpc/openapi@2.0.0-beta.28 @orpc/json-schema@2.0.0-beta.28
pnpm add -D typescript tsx @types/node --allow-build=esbuild
```

```sh [npm]
npm install @btravstack/core @btravstack/http-server @btravstack/orpc-server \
  @btravstack/htmx-server @btravstack/config @btravstack/di \
  @btravstack/contract unthrown @unthrown/orpc@^0.2.0 zod \
  @orpc/server@2.0.0-beta.28 @orpc/contract@2.0.0-beta.28 @orpc/client@2.0.0-beta.28 \
  @orpc/openapi@2.0.0-beta.28 @orpc/json-schema@2.0.0-beta.28
npm install -D typescript tsx @types/node
```

```sh [yarn]
yarn add @btravstack/core @btravstack/http-server @btravstack/orpc-server \
  @btravstack/htmx-server @btravstack/config @btravstack/di \
  @btravstack/contract unthrown @unthrown/orpc@^0.2.0 zod \
  @orpc/server@2.0.0-beta.28 @orpc/contract@2.0.0-beta.28 @orpc/client@2.0.0-beta.28 \
  @orpc/openapi@2.0.0-beta.28 @orpc/json-schema@2.0.0-beta.28
yarn add -D typescript tsx @types/node
```

:::

Most of the first command is **peers** — of `@btravstack/orpc-server`, its
HTTP and htmx packages, and `@unthrown/orpc`, which needs `@orpc/client` — so
your application holds a single copy of each
([why](/explanation/peer-dependencies)). They are named
rather than left to the package manager because not every install adds peers
for you (`pnpm` with `autoInstallPeers: false`, for one), and your own files
import `@orpc/contract`, `@orpc/client`, `zod` and `unthrown` directly.

The five oRPC packages are pinned to **one exact beta**, the one this framework is
built and tested against. oRPC v2 is pre-release and its `latest` tag still
points at the 1.x line, which `@unthrown/orpc` does not peer on, so an
unpinned install resolves the wrong major and the first compile fails; pinning
all five to the same beta keeps the client and the server on one version
([the full list](/reference/packages)).

The dev dependencies split the work: `typescript` **checks** the code,
`tsx` **runs** it (Step 7 says why Node's own type stripping is not enough
here), and `@types/node` types the Node APIs both use. The pnpm line's
`--allow-build=esbuild` lets the bundler `tsx` runs on execute its install
script, which recent pnpm refuses to do until someone approves it.

::: info Which version this site describes
This site is built from `main`, which can be ahead of npm. The version menu in
the navigation bar names the release and commit it was built from, and says
when `main` carries changes npm does not have yet. Before adopting, read
[Support and upgrades](/reference/packages#support-and-upgrades): pre-1.0
minors may break, and fixes land on the latest release only.
:::

## Step 2 — Declare a service

A service is a **port** — a name with a service type — and a **provider** that
builds it. Both live in a **module**, which says what it provides and what it
lets others see:

**`src/greeter.ts`**

```ts
import { Module, Port, Provider } from "@btravstack/di";

export class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

export const GreetingModule = Module("Greeting")({
  provides: [
    Provider(Greeter)({
      inject: {},
      value: { greet: (name) => `Hello, ${name}!` },
    }),
  ],
  exports: [Greeter],
});
```

Nothing here knows about HTTP. That is the point: the module is the
application, and a runtime is something you compose _around_ it in Step 5.

## Step 3 — Write the contract

The transport speaks a contract, declared before any implementation exists. One
procedure, `hello`, with a typed input and output:

**`src/contract.ts`**

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
`api.OrpcRouter(contract)` types the implementation from the contract — a
typo'd key or a wrong output is a compile error here:

**`src/router.ts`**

```ts
import { defineHttp } from "@btravstack/orpc-server";
import { OkAsync } from "unthrown";

import { contract } from "./contract.js";
import { Greeter } from "./greeter.js";

// Held whole and never destructured: each destructured member expands to a
// type mentioning an inaccessible `unique symbol` (TS2527).
const api = defineHttp();

export const greetingRouter = api.OrpcRouter(contract)({
  inject: { greeter: Greeter },
  sync: ({ greeter }) => ({
    hello: (_helpers, input) => OkAsync({ message: greeter.greet(input.name) }),
  }),
});
```

Each leaf is a plain function returning a `Result`. `OkAsync` is the success
case; a declared error would be returned as an `Err` from the `helpers.errors`
map, and the client would receive it typed. Nothing is thrown, and no `os.…`
or `implement(...)` is spelled — the starter does that.

## Step 5 — Compose the application

`HttpModule(name)({...})` is a di `Module(name)({...})` that also takes the
router. Under the hood it imports the HTTP starter, provides the router and
exports `HttpRuntime` — the one port the kernel resolves and drives:

**`src/app.ts`**

```ts
import { HttpModule } from "@btravstack/orpc-server";

import { GreetingModule } from "./greeter.js";
import { greetingRouter } from "./router.js";

export const App = HttpModule("App")({
  router: greetingRouter,
  imports: [GreetingModule],
});
```

Check it:

```sh
npm run typecheck
```

`tsc` prints nothing and exits `0`. Now delete `imports: [GreetingModule]` and
run it again: the call fails to compile, because the router's provider declares
`Greeter` and nothing supplies it. That is di's gate
([Compile errors, not surprises](/explanation/compile-time-wiring)), and it
fires before any process exists.

**Read the sentence, and read it whole.** The error is at the `HttpModule`
call, and it ends by naming what is missing — the marker, and `Greeter` as its
value:

```text
src/app.ts(6,38): error TS2345: Argument of type '{ router: Built<never, Greeter, Record<never, never>>; }' is not assignable to parameter of type …
  Property '"UNDECLARED NEEDS — name it in `needs` (a slice), or import/provide it (a root)"' is missing in type … but required in type '{ readonly "UNDECLARED NEEDS …": Greeter; }'.
```

Two fixes, because two readers meet this. A **slice** names the port in
`needs` and lets whoever composes it supply one. A **composition root** — which
`App` is — has nobody above it, so naming it in `needs` only moves the
complaint one line down, to `runMain`'s own
`UNSATISFIED DEPENDENCIES — nothing provides`. Put the module back in
`imports`. [Read a wiring error](/how-to/read-a-wiring-error) has the marker
table and where each fix goes.

## Step 6 — Write `main.ts`

**`src/main.ts`**

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
PORT=3000 npm start
```

`start` is `tsx src/main.ts`. `tsx` strips the types without checking them, so
it runs code `npm run typecheck` would refuse — keep the check as the step
before.

**`tsx` rather than `node`, and the reason is the `.js` suffixes.** Node `>=22.18`
does run a `.ts` entry point by stripping the types, but stripping is all it
does: it never remaps `./contract.js` to `./contract.ts`, and `.js` is what
`moduleResolution: "nodenext"` makes you write. `node src/main.ts` therefore ends
in `ERR_MODULE_NOT_FOUND` on a file that plainly exists. `tsx` resolves the
suffix and is what this repository's own examples run.

On stderr, one JSON line per kernel event:

```json
{"type":"building"}
{"type":"serving","runtime":"http","info":{"port":3000},"probePort":9000}
```

`info` is whatever the runtime published about itself — `{ port }` for this one,
which is how a `PORT=0` boot tells you what it got — and `probePort` is the
kernel's own listener, not the runtime's.

`PORT` was read _inside_ the graph — the starter binds `PORT` (default `3000`)
and `HOST` (default `0.0.0.0`) onto a `HttpConfig` port from the `Env` port the
kernel provides. Try `PORT=abc` instead: the process prints a `startFailed`
event naming the variable and exits `78`, without your code having parsed
anything.

## Step 8 — Call it

The contract types the client too. `RPCLink` speaks oRPC's RPC protocol to the
endpoint the starter mounted under `/rpc`:

**`src/client.ts`**

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
npm run client
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

Send the process a SIGTERM (Ctrl-C sends SIGINT, which takes the same path).
From another terminal, signal the process listening on the port — the Node
process `tsx` started, not the `npm` wrapper around it:

```sh
kill -TERM $(lsof -ti tcp:3000 -sTCP:LISTEN)
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
