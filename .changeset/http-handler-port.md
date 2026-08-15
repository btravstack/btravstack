---
"@btravstack/http": minor
---

**Breaking.** `@btravstack/http` is the HTTP starter, and there is one way HTTP
is answered: **oRPC, over its own node adapter**. `http({ router })` takes the application's
**router port** — a di `Port` whose service is a context-free oRPC router,
provided by the application from the use cases its procedures call — mounts it
under `prefix` (default `/rpc`) and provides the runtime on
**`HttpRuntime`** (declared over core's `RuntimePort`, `Runtime<never,
HttpInfo>` — no `needs`), which the composition root imports and exports so
`start` finds it. The runtime provider depends on the router port through di,
so a composition that imports the starter without providing its router is
refused at `start`, at compile time.

```ts
class OrderRouter extends Port("OrderRouter")<ReturnType<typeof routerOf>> {}
const orderRouter = Provider(OrderRouter)([PlaceOrder, FindOrder], {
  sync: routerOf,
});

const OrderApi = Module("OrderApi")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    http({ router: OrderRouter }),
  ],
  provides: [orderRouter],
  exports: [HttpRuntime],
});
```

`@btravstack/orpc` is folded into this package and no longer exists. `needs`
and `handler` are gone from `HttpOptions`; `httpRuntime` is no longer
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
plain `Provider` whose instance is constrained to a context-free oRPC router.
`http({ router })` stays exported as the primitive it delegates to.

`HttpRouter(contract)(name)(deps, { sync })` — contract-first: `sync` returns a
record shaped like the contract whose leaves are plain `Result`-returning
functions (the `.result()` handler `@unthrown/orpc` gives an implementer),
typed by the contract at the call; `implement`, `os.…`, `.result(...)` and
`os.router(...)` are done for you. It mints the router's port and returns di's
own `Provider(port)`, carrying the port typed (`orderRouter.port`, di's
`PortClassOf<Name, Router<…>>`); `HttpModule({ router: orderRouter })` takes it
from there. No class line, no
`implement`, no builder in an application. `@orpc/contract` and
`@unthrown/orpc` join the peers.
