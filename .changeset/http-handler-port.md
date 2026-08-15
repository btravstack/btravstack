---
"@btravstack/http": minor
---

**Breaking.** `@btravstack/http` is the HTTP starter, and there is one way HTTP
is answered: **oRPC on Hono**. `http({ router })` takes the application's
**router port** — a di `Port` whose service is a context-free oRPC router,
provided by the application from the use cases its procedures call — mounts it
on Hono under `prefix` (default `/rpc`) and provides the runtime on
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
`StartOptions.unit` module is gone with it. An unmatched path is Hono's `404`
and a defect inside a procedure is oRPC's own `INTERNAL_SERVER_ERROR`;
`Result` → HTTP status stays the router's `.result()` triage. `hono`,
`@hono/node-server` and `@orpc/server` are peer dependencies.
