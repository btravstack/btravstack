---
title: Test a Temporal worker
description: Run a worker's specs against one real Temporal server per test run, a namespace per spec file, with @btravstack/temporal-worker/testing — no time-skipping binary and no pinned testing beta.
---

# Test a Temporal worker

> **How-to.** Boot a `TemporalModule` root in a spec against a real Temporal
> server. For the worker itself see
> [Run a Temporal worker](/how-to/run-a-temporal-worker); for specs in general,
> [Test an application](/how-to/test-an-application).

`@btravstack/temporal-worker/testing` gives a spec suite two things:

- `temporalServer` — a Vitest `globalSetup` that starts one PostgreSQL and one
  `temporalio/auto-setup` container for the whole run, through
  `testcontainers`, and stops them when the run ends;
- `temporalEnvironment` — a file-scoped fixture that registers a namespace for
  the spec file and answers `{ TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE }`, the two
  variables the starter reads.

Install the two optional peers the subpath needs, beside the starter:

```sh
pnpm add -D vitest testcontainers @btravstack/testing
```

The suite needs a **Docker daemon**. It needs no network at test time beyond
the image pulls: Temporal's time-skipping test server is not used, because it
downloads a binary on first use.

## Step 1 — start the server once per run

<!-- doctest: isolate
import { defineConfig } from "vitest/config";
-->

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ["@btravstack/temporal-worker/testing"],
    // The first run pulls two images and creates Temporal's schemas.
    hookTimeout: 300_000,
  },
});
```

The entry's default export is `temporalServer()` with its defaults. Each
container may take up to `startupTimeoutMs` (default `300_000`) to report
healthy — the Docker health check's start period and `testcontainers`' own
wait both get the whole budget, because `auto-setup` creating its schemas on a
loaded host is what a shorter budget fails on. A host that needs more passes
it through a setup module of its own:

<!-- doctest: isolate
import { temporalServer } from "@btravstack/temporal-worker/testing";
-->

```ts
// temporal-setup.ts, named in `globalSetup` instead
export default temporalServer({ startupTimeoutMs: 600_000 });
```

## Step 2 — a namespace per spec file

<!-- doctest: isolate
import { bootFixture, type Boot } from "@btravstack/testing";
import {
  temporalEnvironment,
  type TemporalEnvironment,
} from "@btravstack/temporal-worker/testing";
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
their namespaces are what keep their workflows apart. Nothing is cleaned up;
the run's end disposes of the server and everything in it.

## Step 3 — boot the worker from that environment

<!-- doctest: isolate
import { expect } from "vitest";
import type {} from "@unthrown/vitest";
import { bootFixture, type Boot } from "@btravstack/testing";
import {
  temporalEnvironment,
  type TemporalEnvironment,
} from "@btravstack/temporal-worker/testing";
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

## What it does not do

- **Reuse a server across runs.** One server starts per `vitest run`; a
  long-lived one a CI job provides is reached by passing its address as
  `TEMPORAL_ADDRESS` to `boot` directly.
- **Advance time.** The server's clock is real. A workflow that sleeps for a
  day is tested by its activities and a shorter timer in the spec's contract,
  or by Temporal's own `TestWorkflowEnvironment`, outside this entry.
