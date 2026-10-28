# `@btravstack/temporal-testing`

A Temporal server for the specs of `@btravstack/temporal-worker` and
`@btravstack/temporal-client` consumers. `temporalServer` is a Vitest
`globalSetup` (the package's default export) that starts the Temporal CLI's
development server, `temporalio/temporal` running `server start-dev` in memory,
in one container through `testcontainers`. By default every run on the Docker
host shares that container, concurrent processes included.
`temporalEnvironment(prefix)` is a file-scoped fixture that registers a
namespace of the spec file's own and answers
`{ TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE }`, the variables the starters read.

```sh
pnpm add -D @btravstack/temporal-testing @btravstack/testing vitest testcontainers @temporalio/client @temporalio/common
```

<!-- doctest: isolate
import { defineConfig } from "vitest/config";
-->

```ts
// vitest.config.ts
export default defineConfig({
  test: { globalSetup: ["@btravstack/temporal-testing"] },
});
```

<!-- doctest: isolate
import { bootFixture, type Boot } from "@btravstack/testing";
import { temporalEnvironment, type TemporalEnvironment } from "@btravstack/temporal-testing";
import { test } from "vitest";
-->

```ts
// test-fixtures.ts
export const it = test.extend<{ temporal: TemporalEnvironment; boot: Boot }>({
  temporal: temporalEnvironment("orders"),
  boot: bootFixture(),
});
```

The suite needs a Docker daemon. `temporalServer({ reuse: false })` owns a
server for the run instead, and stops it at the run's end.

## Options

- `startupTimeoutMs`: how long the container may take to report healthy (default `60_000`); see the [reference](https://btravstack.github.io/btravstack/reference/temporal-testing).
- `reuse`: share one server per Docker host (default `true`), or own one per run; see the [reference](https://btravstack.github.io/btravstack/reference/temporal-testing).

See
[Test a Temporal worker](https://btravstack.github.io/btravstack/how-to/test-a-temporal-worker).
