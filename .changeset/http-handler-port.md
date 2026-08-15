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
