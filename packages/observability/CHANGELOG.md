# @btravstack/observability

## 0.2.0

### Minor Changes

- 18e8943: **`@btravstack/observability`** — observability for the kernel, starting with
  logging.

  `Logger` is a di port over a deliberately strict interface, and every
  difference from NestJS's logger is a defect it does not have: a port rather
  than a class you `new` (no static instance, no `useLogger` reaching past DI),
  `with(attributes)` returning a new logger rather than `setContext` mutating the
  one every caller shares, a flat record of scalars rather than `any` varargs, a
  dedicated `cause` channel (an `Error`'s `message` and `stack` are
  non-enumerable, so `JSON.stringify` alone drops exactly the part worth
  keeping), six fixed levels, and a guarantee that a log call cannot throw — a
  broken sink is swallowed rather than becoming an outage.

  - **Correlation is not the caller's job.** `createLogger` reads
    `currentUnit()` **per call**, so every line written inside a unit carries its
    `traceId`, `unitId` and `tenantId` — one application-scope logger, correct
    for every request, with nothing threaded through the call stack.
  - **`observability({ sink?, level? })`** provides `Logger` and `LoggerConfig`,
    bound from `LOG_LEVEL` (default `info`) and validated once: a level outside
    the six is a `ConfigInvalid` naming the variable, exit `78` under `runMain`,
    rather than a silent fallback.
  - **`jsonSink`** is the default — one JSON object per line on stdout, no
    runtime dependency — with the unit's ids as top-level fields a log backend
    indexes. **`pinoSink`** lives behind the `@btravstack/observability/pino`
    subpath, with `pino` as an optional peer; the level filter stays this
    package's, so there is one filter in the process.
  - **`kernelEvents(logger)`** turns the kernel's nine lifecycle events into log
    lines in that same stream, keeping each event's fields as attributes — pass
    it as `StartOptions.onEvent`.

  Traces and metrics are not here yet; the package is named for the whole because
  logs, traces and metrics share a correlation id, a resource, a config slice and
  a flush-on-shutdown lifecycle.

### Patch Changes

- Updated dependencies [f133934]
- Updated dependencies [9ca73c5]
- Updated dependencies [ba815e4]
- Updated dependencies [38d7cd5]
- Updated dependencies [4fa693c]
- Updated dependencies [b56501f]
- Updated dependencies [e616e23]
- Updated dependencies [5a271c0]
- Updated dependencies [72b8fbd]
- Updated dependencies [e950473]
- Updated dependencies [068399d]
  - @btravstack/config@1.0.0
  - @btravstack/core@1.0.0
  - @btravstack/di@1.0.0
