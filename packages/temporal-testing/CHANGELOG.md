# @btravstack/temporal-testing

## 0.51.0

### Minor Changes

- dbca88e: New package: `@btravstack/temporal-testing`, the Temporal test server for the specs of `@btravstack/temporal-worker` and `@btravstack/temporal-client` consumers. It peers on `@temporalio/client`, `@temporalio/common`, `testcontainers` and `vitest`, and on no `@btravstack/*` package. `temporalServer` and `temporalEnvironment` keep their shapes, and so does the default export used as a `globalSetup`.

  The server is now the Temporal CLI's development server: one `temporalio/temporal:1.9.1` container running `server start-dev` in memory. It replaces `temporalio/auto-setup` with PostgreSQL on a network of their own. By default it is **reused**: every Vitest run on the Docker host attaches to one server, including concurrent runs in other processes, and the server outlives the run. Each spec file stays isolated by the namespace `temporalEnvironment` registers. `temporalServer({ reuse: false })` owns a server for the run and stops it at the end. `startupTimeoutMs` now defaults to `60_000`, since the server needs no schema step.

  **Breaking:** `@btravstack/temporal-worker` no longer exports `/testing`, and no longer declares `testcontainers` and `vitest` as optional peers. To migrate:

  - add `@btravstack/temporal-testing` as a dev dependency, with `@temporalio/client` and `@temporalio/common` if the workspace does not already have them;
  - replace `"@btravstack/temporal-worker/testing"` with `"@btravstack/temporal-testing"` in `globalSetup` and in imports;
  - pass `reuse: false` to `temporalServer` to keep stopping the server at the end of each run.

  `testcontainers` and `vitest` stay dev dependencies where they already were. `docker rm -f $(docker ps -aq --filter name=btravstack-temporal-)` removes the shared server.
