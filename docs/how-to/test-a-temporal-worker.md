---
title: Test a Temporal worker
description: Run a worker's specs against one real Temporal server per Docker host, shared across test processes, and a namespace per spec file, with @btravstack/temporal-testing — no time-skipping binary and no pinned testing beta.
---

# Test a Temporal worker

> **How-to.** Boot a `TemporalModule` root in a spec against a real Temporal
> server. For the worker itself see
> [Run a Temporal worker](/how-to/run-a-temporal-worker); for specs in general,
> [Test an application](/how-to/test-an-application).

`@btravstack/temporal-testing` gives a spec suite two things:

- `temporalServer` — a Vitest `globalSetup` that starts the Temporal CLI's
  development server in one container, through `testcontainers`, and
  provides its address. By default every run on the Docker host shares it,
  concurrent processes included;
- `temporalEnvironment` — a file-scoped fixture that registers a namespace for
  the spec file and answers `{ TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE }`, the two
  variables the starter reads;
- `temporalNamespace` — the same registration without a test context, for a
  namespace a `globalSetup` registers for the whole run.

Install it and its peers as dev dependencies, beside the starter:

```sh
pnpm add -D @btravstack/temporal-testing @btravstack/testing vitest testcontainers \
  @temporalio/client @temporalio/common
```

The suite needs a **Docker daemon**. It needs no network at test time beyond
the image pull: Temporal's time-skipping test server is not used, because it
downloads a binary on first use.

## Step 1 — one server for every suite

<!-- doctest: isolate
import { defineConfig } from "vitest/config";
-->

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ["@btravstack/temporal-testing"],
    // The first run pulls the image.
    hookTimeout: 180_000,
  },
});
```

The default export is `temporalServer()` with its defaults. The container is
**reused**: a second Vitest process, in this workspace or another, attaches to
the server the first one started rather than starting its own, and the server
outlives the run, so the next run attaches in well under a second. Processes
that start together converge on one container too. Remove it with
`docker rm -f $(docker ps -aq --filter name=btravstack-temporal-)`.

A run that should own its server, and stop it when the run ends, passes
`reuse: false` through a setup module of its own:

<!-- doctest: isolate
import { temporalServer } from "@btravstack/temporal-testing";
-->

```ts
// temporal-setup.ts, named in `globalSetup` instead
export default temporalServer({ reuse: false });
```

`startupTimeoutMs` (default `60_000`) is how long the container may take to
report healthy, for a host loaded enough to need more.

## Step 2 — a namespace per spec file

<!-- doctest: isolate
import { bootFixture, type Boot } from "@btravstack/testing";
import {
  temporalEnvironment,
  type TemporalEnvironment,
} from "@btravstack/temporal-testing";
import { test } from "vitest";
-->

```ts
// test-fixtures.ts
export const it = test.extend<{ temporal: TemporalEnvironment; boot: Boot }>({
  temporal: temporalEnvironment("orders"),
  boot: bootFixture(),
});
```

`temporalEnvironment(prefix)` registers `<prefix>-<uuid>` once per spec file
and waits until every Temporal service can use it. The namespace is the
isolation boundary, not the task queue: the starter reads its queue off the
contract, so two spec files booting the same worker poll the same queue, and
their namespaces are what keep their workflows apart — and suites that list
workflows on the shared server see only their own. Nothing is cleaned up: a
namespace lives as long as the server.

## Step 3 — boot the worker from that environment

<!-- doctest: isolate
import { expect } from "vitest";
import type {} from "@unthrown/vitest";
import { bootFixture, type Boot } from "@btravstack/testing";
import {
  temporalEnvironment,
  type TemporalEnvironment,
} from "@btravstack/temporal-testing";
import { test } from "vitest";
import type { StartEnvironment } from "@btravstack/core";
import { OrderTemporalWorker } from "../../module.js";
const it = test.extend<{ temporal: TemporalEnvironment; boot: Boot }>({
  temporal: temporalEnvironment("orders"),
  boot: bootFixture(),
});
// What the application itself reads — its database and storage.
declare const deployment: Omit<
  StartEnvironment<typeof OrderTemporalWorker>,
  "TEMPORAL_ADDRESS" | "TEMPORAL_NAMESPACE"
>;
-->

```ts
it("polls this file's own namespace", async ({ temporal, boot }) => {
  // GIVEN the real root, configured by the fixture's environment
  const app = boot(OrderTemporalWorker, {
    env: { ...deployment, ...temporal },
  });

  // WHEN the runtime reports what it polls
  const info = app.runtimeInfo();

  // THEN it is the namespace the fixture registered
  await expect(info).toBeOkWith(
    expect.objectContaining({ namespace: temporal.TEMPORAL_NAMESPACE }),
  );
});
```

`deployment` stands for whatever else the root reads — its database, its
storage; the fixture supplies only the two Temporal variables. `boot` stops
the application when the test ends. A test that needs a queue of
its own — a workflow whose id must not collide with another test's — composes
the root over `{ ...contract, taskQueue }` with a fresh queue name.

## Workers a global setup shares: a namespace per run

Some suites start their workers once, in a `globalSetup` after the server's,
and share them across spec files. Those workers must not poll a fixed
namespace such as `default`: the server is shared, so every run on the Docker
host would take the others' tasks. `temporalNamespace(address, prefix)`
registers `<prefix>-<uuid>` and waits until it is usable, as
`temporalEnvironment` does, but needs neither `inject` nor `vi`, so it runs in
a global setup:

<!-- doctest: isolate
import { temporalNamespace, type TemporalEnvironment } from "@btravstack/temporal-testing";
import type { TestProject } from "vitest/node";
// The suite's own: boots its workers in this environment, answering their stop.
declare const startWorkers: (temporal: TemporalEnvironment) => Promise<() => Promise<void>>;
-->

```ts
// workers-setup.ts:
// globalSetup: ["@btravstack/temporal-testing", "./workers-setup.ts"]
declare module "vitest" {
  interface ProvidedContext {
    workers: TemporalEnvironment;
  }
}

export default async (project: TestProject) => {
  const address = project.getProvidedContext().__BTRAVSTACK_TEMPORAL_ADDRESS__;
  const temporal: TemporalEnvironment = {
    TEMPORAL_ADDRESS: address,
    TEMPORAL_NAMESPACE: await temporalNamespace(address, "workers"),
  };
  project.provide("workers", temporal);
  return startWorkers(temporal);
};
```

Vitest runs global setups in order, so the server's address is provided
before this setup reads it, and its teardown, the workers' stop, runs first.
A spec reads the run's environment with `inject("workers")`, to start
workflows its shared workers serve.

## What it does not do

- **Advance time.** The server's clock is real. A workflow that sleeps for a
  day is tested by its activities and a shorter timer in the spec's contract,
  or by Temporal's own `TestWorkflowEnvironment`, outside this package.
- **Persist across a restart.** The development server keeps its state in
  memory, and a namespace lives as long as the container does.
