# @btravstack/http-server

## 0.2.0

### Minor Changes

- f133934: **Configuration, the twelve-factor way, in its own package.** `@btravstack/config`
  exports `Env` — the environment as a port, which `@btravstack/core` provides to
  every graph `start` boots (`process.env`, or `StartOptions.env` for a test) —
  and `Config`:
  `Config.string/integer/port(variable, { default?, min?, max? })` fields,
  `Config.object({...})` composing them into a Standard Schema over the
  environment (any other Standard Schema, a `zod` object over the raw variables
  for instance, is accepted too), and `Config.provider(Port)(schema)` binding a
  port from `Env` — a modeled `ConfigInvalid` naming every offending variable
  when the environment is wrong, which `runMain` maps to sysexits(3)'s
  `EX_CONFIG` (78) rather than the generic startup `1`. The kernel binds its own
  `PROBE_PORT` the same way (default `9000`; `probes` still overrides), and a
  startup failure of any kind is now reported as a `startFailed` kernel event
  before `stopping`, so a bad environment is named on stderr instead of exiting
  silently. An empty or blank variable is an error, never an absent one; `PORT=0`
  stays expressible.

  `@btravstack/http-server` becomes a starter: `http()` provides
  `HttpRuntime` and `HttpConfig`, bound from `PORT` (default `3000`) and `HOST`
  (default `0.0.0.0`) unless pinned (`http({ port: 0 })` for a test —
  explicit beats environment beats default, per field, through
  `Config.pinned(value, field)`; a pinned field reads nothing from the
  environment, and the module's declared `Env` need and `ConfigInvalid` stay
  whatever is pinned). `RuntimeNeedsGate` is renamed `StartGate`, since it now
  also states `NO RUNTIME`.

  `Config.provider("Name")(schema)` — the name form — mints the port (its
  service is the schema's output) and returns the provider carrying it typed
  (`provider.port`), the shape for a slice that is one application's own; the
  class form `Config.provider(Port)(schema)` stays for a slice that is public
  API another package names. Config is the one sugar that takes a name — several
  config slices per application is normal, and the name is what `ConfigInvalid`
  prints; the starters' `HttpRouter` / `TemporalActivities` / `AmqpHandlers`
  provide the starter's own fixed port and take none.

- ee6c612: **Breaking.** `@btravstack/http-server` is the HTTP starter, and there is one way HTTP
  is answered: **oRPC, over its own node adapter**. `http()` mounts the
  application's router under `prefix` (default `/rpc`) and provides the runtime
  on **`HttpRuntime`** (declared over core's `RuntimePort`, `Runtime<never,
HttpInfo>` — no `needs`), which the composition root imports and exports so
  `start` finds it. The router is not an option: it is a **provider on the
  starter's own router port** — one id, `Port("HttpRouter")`, framework-owned
  like `HttpConfig`, since a process serves one router as it boots one runtime —
  whose service is a context-free oRPC router built from the use cases its
  procedures call. The starter **needs** that port through di, so a composition
  that imports it without providing a router is refused at `start`, at compile
  time; two router providers in one graph are di's duplicate-provider defect at
  build.

  ```ts
  const orderRouter = HttpRouter(orderContract)([PlaceOrder, FindOrder], {
    sync: (place, find) => ({ orders: { place: …, find: … } }),
  });

  const OrderApi = Module("OrderApi")({
    imports: [ApplicationModule, PersistenceModule, http()],
    provides: [orderRouter],
    exports: [HttpRuntime],
  });
  ```

  `@btravstack/orpc` is folded into this package and no longer exists. `needs`,
  `handler` and `router` are gone from `HttpOptions`; `httpRuntime` is no longer
  exported; the node listener port `HttpHandler` is internal — an application
  provides a router, never a handler, and a handler built per request by the
  `StartOptions.unit` module is gone with it. An unmatched path is declined
  unwritten by oRPC and answered by the runtime's own `404`, and a defect inside
  a procedure is oRPC's own `INTERNAL_SERVER_ERROR`; `Result` → HTTP status
  stays the router's `.result()` triage. `@orpc/server`, `@orpc/contract` and
  `@unthrown/orpc` are peer dependencies — not `hono` or `@hono/node-server`,
  which routed one pattern to oRPC's fetch adapter and are gone.

  **`HttpModule(name)({ router, prefix?, port?, hostname?, imports?, provides?, exports? })`**
  is the way an application declares an HTTP deployment: `Module(name)({...})`
  plus the router **provider**. It imports the starter, provides the router,
  exports `HttpRuntime`, and hands the augmented imports/provides/exports to
  di's own `Module(name)({...})`, whose return type is the sugar's — sugar over
  the same primitives, nothing new for the kernel or the gates. `router` is a
  plain `Provider` on the starter's router port, which is what `HttpRouter`
  returns. `http()` stays exported as the primitive it delegates to.

  `HttpRouter(contract)(deps, { sync })` — contract-first: `sync` returns a
  record shaped like the contract whose leaves are plain `Result`-returning
  functions (the `.result()` handler `@unthrown/orpc` gives an implementer),
  typed by the contract at the call; `implement`, `os.…`, `.result(...)` and
  `os.router(...)` are done for you. It is di's own `Provider(port)` on the
  starter's router port — no name to give, no class line — returning the
  provider with the port typed (`orderRouter.port`, di's
  `PortClassOf<"HttpRouter", Router<…>>`) for a hand-declared provider or a
  type test; `HttpModule({ router: orderRouter })` takes it from there.
  `@orpc/contract` and `@unthrown/orpc` join the peers.

- 2f1974e: The HTTP runtime for `@btravstack/core`.

  `httpRuntime({ port, needs, handler })` owns an HTTP server's lifecycle and
  nothing else: it binds (publishing the real port on `Serving.info`, so
  `port: 0` is usable), opens one kernel unit per request, drains by genuinely
  refusing new work, and stops by destroying what is left.

  Its guarantee is that every request produces exactly one completed response,
  and the unit stays open until that response is on the wire — which makes the
  kernel's least-checkable contract structural rather than documented. Routing,
  middleware and `Result` → HTTP status are deliberately not included: bring an
  oRPC router (see the starter entry below).

### Patch Changes

- d3564a9: Two consequences of the kernel's new `StartOptions.unit`. A unit whose work
  begins after its response has already closed — a client that hung up during a
  slow per-request build — now settles at once instead of waiting for a `'close'`
  event that already fired, which held the unit open for the process lifetime.
  And a defect that never reaches the handler's promise — a synchronous throw, or
  a unit provider that failed to build — now answers `500` when no headers are
  out, rather than only resetting the connection.
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
  - @btravstack/config@0.2.0
  - @btravstack/core@0.2.0
  - @btravstack/di@0.2.0
