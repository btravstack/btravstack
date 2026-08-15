---
"@btravstack/http": minor
---

**Breaking.** The handler is a port, not an option. `@btravstack/http` now
exports `HttpHandler` — a di `Port` whose service is
`(request, response, signal) => PromiseLike<unknown>` — and `httpRuntime`
takes only `{ port, hostname? }`, needing exactly that port and resolving it
out of **each request's** context. Provide it in the module `start` boots:

```ts
Provider(HttpHandler)([OrderRouter], { sync: (router) => getRequestListener(…) });
```

Because the runtime resolves it per request, the provider may live in the
`StartOptions.unit` module instead, where it is built once per request with
per-request dependencies constructor-injected — the reason there is no
`ctx` argument any more. `needs` and `handler` are gone from `HttpOptions`;
the `HttpHandler<Needs>` function type is replaced by the port class.

**Breaking, in the same release.** The runtime is a module, not an option:
`httpModule(options)` provides the runtime on the new **`HttpRuntime`** port
(declared over core's `RuntimePort`), which the composition root imports and
exports — `start(module)` resolves it from there, since `StartOptions.runtime`
is gone. `httpRuntime` is no longer exported.

```ts
const OrderApiModule = Module("OrderApi")({
  imports: [ApplicationModule, ApiModule, httpModule({ port: env.PORT })],
  exports: [HttpRuntime, HttpHandler],
});
```
