# `examples/` — real runtimes as the integration suite — Design

**Date:** 2026-08-11
**Status:** Approved, pending implementation plan
**Repo:** `btravstack/start`

## Purpose

Every sibling repo (`btravstack/di`, `btravstack/entity`) carries an `examples/`
directory of private workspace packages that are both documentation and
integration tests. This repo has none. It needs them for a reason specific to
what it ships: **every runtime in the current test suite is `Runtime<never>`.**

`testRuntime` declares no needs, so two of the package's load-bearing type
mechanisms have never been exercised against a runtime with real dependencies:

- `RuntimeHost.ctx` is `Context<InstanceType<Needs>>`, the fix for a kind
  mismatch between port classes and port instance types.
- The trailing phantom rest-tuple gate on `start`, which relates a runtime's
  declared `Needs` to the application module's exports.

Task 7's review said plainly that the first runtime with non-empty `needs` would
hit this. These examples are that runtime.

## Structure

Two private workspace packages, following the sibling convention exactly
(`private: true`, `main`/`exports` pointing at `src/index.ts`, `test: vitest run`,
`typecheck: tsc --noEmit`, `@btravstack/tsconfig` + `@unthrown/vitest` devDeps,
`@btravstack/start: workspace:*`).

```
examples/
  README.md
  http-api/    @btravstack/start-example-http-api
    src/app.ts                  ports, adapters, use cases — the AppModule
    src/http-runtime.ts         a real Runtime over node:http
    src/index.ts                start(AppModule, { runtime: http({ port }) })
    src/*.spec.ts
    src/needs-gate.test-d.ts
  worker/      @btravstack/start-example-worker
    src/queue-runtime.ts        a second Runtime kind, in-memory queue
    src/index.ts                the same AppModule, a different runtime
    src/*.spec.ts
```

`pnpm-workspace.yaml` gains `examples/*`. Turbo's task graph is already generic,
so the root gate picks both up with no new task definitions.

**The shared `AppModule` lives in `http-api`, and `worker` depends on it.** A
third `shared-app` package would be tidier in the abstract, but the dependency
edge is itself the demonstration: `worker` importing `http-api`'s module is what
proves one module boots under two different runtimes. This mirrors
`@btravstack/entity`'s `billing-api → billing-domain` edge.

## What the examples prove that no existing test does

1. **A runtime with non-empty `needs`.** `http-runtime` declares `needs: [Router]`.
   First real exercise of `Context<InstanceType<Needs>>` and of the phantom gate.
   `needs-gate.test-d.ts` asserts both directions: a runtime whose needs the
   module exports compiles; one needing an unexported port does not
   (`@ts-expect-error`).
2. **`Result` → transport mapping, at the edge.** A domain `Err` becomes 409/404,
   a `Defect` becomes 500, and the kernel is shown doing none of it. The worker
   maps the same outcomes to ack / retry / dead-letter — one `Result`, two
   transports, which is the thesis "the kernel never maps an outcome to a
   transport" made concrete.
3. **Per-request units.** Each request runs through `host.run(...)`, so a logger
   adapter reads `traceId` from the ambient store while the use case takes its
   collaborators from `Context` — "ambient carries data, `Context` carries
   capabilities", demonstrated rather than asserted.
4. **Draining a real server.** An in-flight request completes; one started after
   the drain begins is refused; the `DrainReport` reads
   `{ completed: 1, abandoned: 0 }`. A deliberately hung request is aborted at
   the deadline and counted. This is the first end-to-end proof of arithmetic
   that was capable of going negative before Task 8's fix round.
5. **Probes against a real process**, which also makes the known `127.0.0.1`
   bind limitation observable rather than theoretical.

## Non-goals

- No published package: both examples stay `private: true`, and no changeset.
- No real broker, database or HTTP client library. `node:http` and an in-memory
  queue only — the point is to exercise `@btravstack/start`, not to demonstrate
  infrastructure. The repo's zero-runtime-dependency discipline extends here.
- Not a replacement for the unit suites in `packages/start`. These are
  integration examples; the invariants suite stays where it is.
