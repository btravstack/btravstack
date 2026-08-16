# @btravstack/http

> The HTTP starter for [`@btravstack/core`](../core): oRPC over `node:http`,
> one unit per request, and a drain that actually stops accepting. There is
> **one** way HTTP is answered here — an oRPC contract, implemented as a
> `Result`-returning record — and it is enforced, not offered among
> alternatives.

📖 **[Documentation](https://btravstack.github.io/start/how-to/serve-orpc-over-http)** ·
[Reference](https://btravstack.github.io/start/reference/http) ·
[API Reference](https://btravstack.github.io/start/api/http/)

```sh
pnpm add @btravstack/http @btravstack/core @btravstack/config @btravstack/di unthrown \
  @orpc/server @orpc/contract @unthrown/orpc
```

All of those are peer dependencies — install every one, so the application
holds a single copy of each. Node `>=20`. Not yet published: this repository
has not cut a release yet.

## A worked example

```ts
import { runMain } from "@btravstack/core";
import { HttpModule, HttpRouter } from "@btravstack/http";
import { P } from "unthrown";

// Contract-first: the record is shaped like the contract, each leaf a plain
// Result-returning function typed by it. The use cases arrive as arguments —
// di injects them; oRPC's context stays empty.
const orderRouter = HttpRouter(orderContract)("OrderRouter")(
  [PlaceOrder, FindOrder],
  {
    sync: (place, find) => ({
      orders: {
        place: ({ errors }, input) =>
          place
            .execute(input.id, input.quantity)
            .map(view)
            // The one place a domain error becomes a transport one — exhaustive.
            .mapErrCases((matcher) =>
              matcher.with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({
                  message: error.message,
                  data: { id: error.id },
                }),
              ),
            ),
        find: ({ errors }, input) =>
          find.execute(input.id).map(view).mapErrCases(/* … */),
      },
    }),
  },
);

// A di module that also knows about its router: imports the starter, provides
// the router, exports the runtime port — nothing else to spell.
const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [Application, Persistence],
});

await runMain(OrderApi);
```

That is a whole `main.ts`. `PORT` (default `3000`), `HOST` (default `0.0.0.0`)
and the kernel's `PROBE_PORT` are read inside the graph; the router is mounted
under `/rpc`; a test boots the same module with
`start(OrderApi, { env: { PORT: "0", HOST: "127.0.0.1" } })` and reads the bound
port back from `app.runtimeInfo()`.

## What it guarantees

Every request produces exactly one completed response, and its unit stays open
until that response is on the wire — the kernel's least-checkable contract,
made structural. A procedure's output or the `ORPCError` its `Result` was
mapped to is oRPC's; a defect inside a procedure is oRPC's own
`INTERNAL_SERVER_ERROR` collapse; an unmatched path is the package's `404`.
`Result` → HTTP status is the router's `.result()` triage — this package maps
nothing. The drain retires busy keep-alive connections; a client's
`x-request-id` becomes the unit's `traceId`. The rest is on the
[documentation site](https://btravstack.github.io/start/reference/http).

## License

[MIT](./LICENSE) © Benoit TRAVERS
