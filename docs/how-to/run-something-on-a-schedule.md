---
title: Run something on a schedule
description: Why scheduled work runs on Temporal Schedules here rather than on an in-process cron, what that costs, and how ensureSchedule registers one idempotently from a deploy.
---

<!-- doctest: prelude
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { Client } from "@temporalio/client";
declare const client: Client;
-->

# Run something on a schedule

> **How-to.** The position this rests on is
> [the transport role map](/explanation/design-decisions): orchestration —
> and with it everything job-queue-shaped and everything **scheduled** — is
> `@btravstack/temporal-worker`. For the worker itself see
> [Run a Temporal worker](/how-to/run-a-temporal-worker).

**A nightly report runs as a Temporal Schedule, and the floor for that is a
Temporal cluster.** That is a real cost and it is stated here rather than
discovered after adoption: every competing framework answers "run this every
hour" in one line with no new infrastructure, and this one does not.

## Why a cluster, and not a `setInterval` in the process

The in-process answer is one line and is wrong in four ways at once, all of
which show up in production and none of which show up in development:

- **N replicas fire N times.** The report is sent three times, or the invoice is
  raised three times. Nothing in a scheduler you write yourself fixes this
  without a lock, and a lock needs a store, and now you are building the
  cluster's job badly.
- **A missed window is silently missed.** A pod restarting at 03:00 skips the
  03:00 run and nothing records that it did. Temporal's catch-up window and
  overlap policy are answers to a question an interval timer cannot even ask.
- **A retry has nowhere to live.** The job fails at 03:00; the next attempt is
  at 03:00 tomorrow, and the code that would have retried it in between is a
  workflow you have started writing.
- **It fights the drain.** [The three-beat drain](/how-to/tune-the-drain-for-kubernetes)
  is about in-flight work having a deadline. A timer that fires during beat 2
  starts work the process is about to stop waiting for.

`@nestjs/schedule` and its equivalents ship the first bullet as a documented
caveat. This stack declines to, because the whole point of the drain, the
probes and the exit codes is that the deployment story is the product.

**So the honest summary is: if you need one scheduled job and nothing else,
this stack is a bad fit for that one job — run it as a Kubernetes `CronJob`
against your own API.** If you already have a Temporal cluster, or your
scheduled work has retries, compensation or a result anyone waits on, the
cluster stops being overhead and starts being the reason it works.

## Registering one, idempotently

The typed schedule client is `@temporal-contract/client`'s — a schedule fires a
workflow, and the workflow's name, task queue and input schema all come off the
contract the worker already serves. What this package adds is the one thing a
deploy needs and `create` does not do:

```ts
import { ensureSchedule } from "@btravstack/temporal-worker/schedule";
import { TypedClient } from "@temporal-contract/client";

const typed = (await TypedClient.create({ client })).get();

const registered = await ensureSchedule(typed.for(orderContract).schedule, "fulfillOrder", {
  scheduleId: "nightly-fulfillment-sweep",
  spec: { cronExpressions: ["0 3 * * *"] },
  args: { tenantId: "acme", orderId: "sweep", quantity: 1 },
});

// Errors are values here, so a deploy that ignores this exits 0 with no
// schedule registered — which is the failure this whole page is about.
process.exitCode = registered.isOk() ? 0 : 1;
```

`create` answers `ScheduleAlreadyExistsError` for an id already in use, which is
correct and is the wrong shape for the one place schedules are registered: a
**deploy**, which runs again on every release. `ensureSchedule` recovers exactly
that error into an `update`, so the schedule after the call is the one the
arguments describe whether or not it existed.

The repair people reach for instead is a `try`/ignore, and it hides the failure
that matters: a schedule that exists with a spec **nobody changed on the
server** because the deploy stopped writing it. A cron that silently stopped
matching the code is worse than a deploy that fails loudly.

**`spec` is the only field reconciled**, and the two reasons are worth telling
apart:

- **`state` is preserved deliberately.** A schedule an operator paused stays
  paused across a deploy; unpausing it is a decision a person made, and a deploy
  is not the place to reverse it.
- **`args` and the rest of the action are preserved because this cannot
  reconcile them safely.** `create` validates `args` against the workflow's
  input schema; the handle's `update` takes Temporal's own shape and validates
  nothing, so writing them here would push unvalidated input at the server
  through a door the typed client keeps shut.

So after the call the schedule **fires when** the arguments say; **what it
fires with** is whatever it already fired with. Changing that is an explicit
act — delete and create, or reach `getHandle(id).update(...)` and own the
shape.

## Where to call it

At deploy time, from a one-shot script or a Kubernetes `Job` — not from the
worker's own boot. A worker that registers its schedules while starting
registers them once per replica, and the point of `ensureSchedule` is that this
is harmless, not that it is a good idea: it makes N replicas write the same
schedule N times on every rollout, and it couples "the worker can start" to "the
Temporal namespace accepts a write".

## What is deliberately not here

**No `@Scheduled`-style decorator and no scheduler runtime.** A workflow already
IS a durable job with a handle, and Temporal Schedules are the cron — a
scheduler package would re-ship those semantics with fewer of them. That is the
same reasoning that says there is no job-queue runtime.
