---
title: The same application, a second runtime
description: Boot the module from the first lesson as a Temporal worker — a second composition root and a second main.ts, sharing one application module.
---

# The same application, a second runtime

> **Tutorial.** The second hands-on lesson. It assumes you finished
> [Getting started](/tutorial/getting-started) and have `GreetingModule` and
> `Greeter` in `greeter.ts`. We keep explanation to a minimum here and link
> out to it.

By the end you will have **two `main.ts` files sharing one application
module**: the HTTP service from lesson one, and a Temporal worker that runs
the same `Greeter` as an activity. That is the kernel's first thesis made
concrete — one process boots one runtime, and a second deployment is a second
composition root, not a second flag ([why](/explanation/one-process-one-runtime)).

## Step 1 — Install the Temporal starter

::: code-group

```sh [pnpm]
pnpm add @btravstack/temporal @temporalio/worker @temporalio/activity @temporalio/common @temporal-contract/worker @temporal-contract/contract zod
```

```sh [npm]
npm install @btravstack/temporal @temporalio/worker @temporalio/activity @temporalio/common @temporal-contract/worker @temporal-contract/contract zod
```

```sh [yarn]
yarn add @btravstack/temporal @temporalio/worker @temporalio/activity @temporalio/common @temporal-contract/worker @temporal-contract/contract zod
```

:::

`@btravstack/core`, `config`, `di` and `unthrown` are already there from
lesson one; the rest are `@btravstack/temporal`'s peers. `zod` is for the
contract, the same as lesson one's — and it earns its place twice over here,
because Temporal persists every input and output and replays them later.

You also need a Temporal service to poll. The
[Temporal CLI](https://docs.temporal.io/cli) ships one for development:

```sh
temporal server start-dev
```

## Step 2 — Write the contract

Where lesson one declared an oRPC procedure, this declares an **activity** and
the **workflow** that calls it, on a named task queue:

```ts
// temporal-contract.ts
import {
  defineActivity,
  defineContract,
  defineWorkflow,
} from "@temporal-contract/contract";
import { z } from "zod";

const greet = defineActivity({
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  activityOptions: { startToCloseTimeout: "1 minute" },
});

const greeting = defineWorkflow({
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  idempotency: "allow-duplicate",
  activities: { greet },
});

export const greetingContract = defineContract({
  taskQueue: "greetings",
  workflows: { greeting },
});
```

`taskQueue` is part of the contract because a worker's identity _is_ its task
queue — the starter reads it from here rather than taking it as an option.

## Step 3 — Implement the activity

`TemporalActivities(contract)` is the Temporal twin of `HttpRouter`: di's own
`Provider(port)` on the starter's activities port, typed for the contract —
its service is the contract's activities record — so the next call declares
its dependencies exactly as the router did:

```ts
// activities.ts
import { TemporalActivities } from "@btravstack/temporal";
import { OkAsync } from "unthrown";

import { Greeter } from "./greeter.js";
import { greetingContract } from "./temporal-contract.js";

export const greetingActivities = TemporalActivities(greetingContract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      greeting: {
        greet: (args) => OkAsync({ message: greeter.greet(args.name) }),
      },
    }),
  },
);
```

Same `Greeter`, same `greet`, a different transport around it. The activity is
a closure over the service its provider declared — no context is read at call
time.

## Step 4 — Write the workflow

Workflow code runs in Temporal's deterministic sandbox, bundled separately from
the worker, so it lives in its own file and touches neither di nor the
`Greeter` — only the activity:

```ts
// workflows.ts
import {
  declareWorkflow,
  propagateActivityFailure,
} from "@temporal-contract/worker/workflow";

import { greetingContract } from "./temporal-contract.js";

export const greeting = declareWorkflow({
  workflowName: "greeting",
  contract: greetingContract,
  implementation: (context, args) =>
    propagateActivityFailure(context.activities.greet({ name: args.name })),
});
```

`propagateActivityFailure` hands an activity's platform failure — retries
exhausted, cancelled — back to Temporal untouched. The contract declared no
errors of its own, so there is nothing else to triage.

## Step 5 — Compose the second root

`TemporalModule(name)({...})` is `HttpModule`'s twin: a `Module(name)({...})`
that also takes the contract, the activities provider and where the workflow
code lives, imports the Temporal starter, and exports `TemporalRuntime`:

```ts
// worker.ts
import { Env } from "@btravstack/config";
import { TemporalModule } from "@btravstack/temporal";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";

import { greetingActivities } from "./activities.js";
import { GreetingModule } from "./greeter.js";
import { greetingContract } from "./temporal-contract.js";

export const Worker = TemporalModule("Worker")({
  needs: [Env],
  contract: greetingContract,
  activities: greetingActivities,
  workflows: {
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  },
  imports: [GreetingModule],
});
```

Compare it with `app.ts` from lesson one. `imports: [GreetingModule]` is the
same line; what changed is the starter around it. And the same gate holds:
drop the import and `TemporalModule(...)` stops compiling, because the
activities provider declares `Greeter`.

## Step 6 — Write the second `main.ts`

```ts
// worker-main.ts
import { runMain } from "@btravstack/core";

import { Worker } from "./worker.js";

await runMain(Worker);
```

Identical to lesson one's, down to the import. Run it:

```sh
node src/worker-main.ts
```

`TEMPORAL_ADDRESS` (default `127.0.0.1:7233`) and `TEMPORAL_NAMESPACE`
(default `default`) are read inside the graph, the way `PORT` was; the
connection is a resource of the graph, opened with the scope and closed on
every exit path. A service that will not answer is a modeled
`TemporalUnreachable` and exit code `1` — an operator can act on it — not a
crash.

## Step 7 — Start a workflow

```sh
temporal workflow start --task-queue greetings --type greeting --input '{"name":"world"}'
temporal workflow result --workflow-id <id>
```

The worker picks the task up, runs `greet` through the same `Greeter` lesson
one served over HTTP, and answers `{"message":"Hello, world!"}`.

## What you now have

Two entry points, one application:

```
src/greeter.ts            GreetingModule — the application, knows no transport
src/main.ts               runMain(App)     — HTTP:     PORT, HOST
src/worker-main.ts        runMain(Worker)  — Temporal: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE
```

Each is a process of its own: it scales, fails and deploys independently, and
there is never a question of how two runtimes in one process would share a
drain deadline. What a running process is doing is readable from the outside
too — `start`'s `RunningApp.runtimeInfo()` resolves what the runtime published
about itself once it is serving: `{ port }` for the HTTP one,
`{ taskQueue, namespace }` for the worker.

## Where next

- [One process, one runtime](/explanation/one-process-one-runtime) — the
  reasoning, and what a multi-runtime process would have cost.
- [Run a Temporal worker](/how-to/run-a-temporal-worker) — the full starter:
  pinning, `gracePeriod`/`forceAfter`, and how a domain error becomes a
  `nonRetryable` contract error.
- [Order Temporal worker](/examples/order-temporal-worker) — the same shape
  with a real saga behind it.
