---
"@btravstack/http": minor
---

**Breaking.** `@btravstack/http` is the HTTP starter, and there is one way HTTP
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
