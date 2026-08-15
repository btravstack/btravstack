# `@btravstack/core` example: the order API layer

The transport. A router implementing
[`order-api-contract`](../order-api-contract), provided as a port and served
under the kernel's lifecycle by [`@btravstack/http`](../../packages/http). One
stack, all of it in the graph: oRPC owns the contract, `@unthrown/orpc` owns
the `Result` bridge, the `http` starter owns Hono, the fetch adapter and the
socket, and the router itself is a di-provided service. The contract lives in
its own package, because a client needs it and needs none of this.

```
src/router.ts         the implementation as a provider, and the one place a domain error becomes an ORPCError
src/request-scope.ts  RequestModule — passed as StartOptions.unit; the kernel forks it per request
src/client.ts         an AsyncResult client for the same contract
src/module.ts         OrderApi — the composition root, HttpModule("OrderApi")({ router: orderRouter, … })
src/main.ts           the process: runMain(OrderApi, { unit: RequestModule })
src/test-fixtures.ts  serve / clientFor / gate / tapped, as Vitest fixtures
```

## The two channels survive the wire

oRPC v2 splits failures the way unthrown does. An error a procedure **declares**
(or returns as a value) is _inferable_ — typed end to end; everything else
collapses to `INTERNAL_SERVER_ERROR`. That maps onto the variants with no
adapter in between:

| unthrown     | oRPC                    |
| ------------ | ----------------------- |
| `Ok(value)`  | the procedure's output  |
| `Err(error)` | a returned `ORPCError`  |
| `Defect`     | `INTERNAL_SERVER_ERROR` |

None of it is the kernel's doing — which is what
[`order-temporal-worker`](../order-temporal-worker) demonstrates by folding the
very same `Result` into typed contract errors over the very same composition
root, and [`order-amqp-worker`](../order-amqp-worker) by never folding it at a
consumer at all — its writes broadcast facts instead.

Each procedure is a plain `Result`-returning function — `@unthrown/orpc`'s
`.result(...)` handler, which `HttpRouter(orderContract)` attaches for you —
and that is what performs the elimination; the `mapErrCases` inside it is the
triage point — the boundary where the application's vocabulary stops:

```ts
place
  .execute(input.id, input.quantity)
  .map(view)
  .mapErrCases((matcher) =>
    matcher
      .with(P.tag("InvalidQuantity"), (error) =>
        errors.INVALID_QUANTITY({
          message: error.message,
          data: { id: error.id },
        }),
      )
      .with(P.tag("DuplicateOrder"), (error) =>
        errors.CONFLICT({ message: error.message, data: { id: error.id } }),
      ),
  );
```

Every case is named — this repo bans `P._`, and `mapErrCases` has no
`.otherwise()`. A new domain error is a compile error here, at the one file that
has to decide what a client sees. A `Defect` is never named: it has no code
because it was never modelled, and collapsing it to a 500 is the correct
treatment rather than a fallback.

## The transport is `@btravstack/http`, all of it

Binding the socket, one unit per request, the drain that retires a busy
keep-alive connection, the trace-id policy, Hono and oRPC's fetch adapter
mounted under `/rpc` all live in [`@btravstack/http`](../../packages/http) —
see its README for the guarantee it makes and the one way it answers HTTP.
What this example writes is the router — `HttpRouter(orderContract)("OrderRouter")([PlaceOrder,
FindOrder], { sync: (place, find) => ({ orders: { place: …, find: … } }) })`,
contract-first: port and provider in one call, each procedure a plain
`Result`-returning function typed by the contract, built from the two use
cases it declares — and a composition root that is a `Module(...)` which also
knows about it:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [ApplicationModule, PersistenceModule],
  exports: [Logger],
});
```

`HttpModule` is sugar over the same primitives: it imports the starter
(`http({ router: OrderRouter })` — the whole surface), provides the router and
exports `HttpRuntime`, and returns exactly the di module `Module("OrderApi")({
imports: [ApplicationModule, PersistenceModule, http({ router: OrderRouter })],
provides: [orderRouter], exports: [HttpRuntime, Logger] })` would have. The
runtime provider depends on the router port through di, so even the transport
wiring exists because the composition root said so — a composition that
imports the starter without providing `OrderRouter` carries an unmet need
`start` refuses (`needs-gate.test-d.ts` pins it with the hand-written form) —
and oRPC's own context stays empty, since one container is enough. `port` is
read back off `Serving.info` the same way any caller of the package does.

### One unit per call

The unit's lifetime **is** the response's: `@btravstack/http` keeps it open
until the response completes, so there is no seam for a late write to land in.
An unmatched path is Hono's 404; a defect inside a procedure is oRPC's own
`INTERNAL_SERVER_ERROR` collapse — nothing left to dispatch or end by hand.
The router itself needs nothing per request, so it lives at application scope;
what does is forked by the kernel, below.

### A request scope over the application scope

The application scope is opened once, by the kernel, and holds the database.
Opening another per request would give every request its own empty in-memory
database — so the **kernel forks**: `RequestModule`, passed as
`StartOptions.unit`, is layered as a short-lived scope over the one already
built, per request, and a request-scoped provider reads what the parent
constructed instead of rebuilding it. `RequestSpan`'s `onStop` runs while the
unit is still open, which is what gives its line the request's own trace id —
and no handler code manages any of it.

## The client half

```ts
const client = createOrderApiClient("http://127.0.0.1:3000");

const named = (await client.orders.place({ id, quantity })).match({
  ok: () => "placed",
  errCases: (matcher) =>
    matcher.with(
      { code: "INVALID_QUANTITY" },
      { code: "CONFLICT" },
      (error) => error.code,
    ),
  defect: () => "bug",
});
```

The error channel is the raw `ORPCError` union discriminated by `code` — not
re-wrapped into a second error concept — so the client's match is the mirror of
the server's `mapErrCases`.

## Running it

```bash
pnpm --filter @btravstack/example-order-api test  # 15 api specs
```

The specs run against a real HTTP server and a real oRPC client — genuine JSON
serialization, which is where the defect collapse to `INTERNAL_SERVER_ERROR`
actually happens. No Docker, nothing to install.

Every helper they need is a Vitest fixture in `src/test-fixtures.ts`, so the spec
opens on `describe` and each test names its dependencies in its own parameter
list. Shutting an app down is the `serve` fixture's job, which is why no test
here has a `try`/`finally`: fixture cleanup runs even when the body fails, and it
still asserts the app exited `Ok`.

```ts
it("lets an in-flight call finish while draining", async ({ serve, clientFor, gate }) => {
  // GIVEN a call held open inside the repository
  const app = serve(gate.api);
  …
});
```

`serve` boots whatever composition it is handed with
`env: { PORT: "0", HOST: "127.0.0.1" }` — the real `OrderApi` included, since
`http()` reads its port from the environment the kernel provides — and reads
the port it got back from `runtimeInfo()`.

`src/main.ts` is the process itself, and it is one call:

```ts
await runMain(OrderApi, { unit: RequestModule });
```

Configuration is read **inside the graph**: `http()` binds `PORT` (default
`3000`) and `HOST` (default `0.0.0.0`) from the `Env` port the kernel provides,
and the kernel binds its own `PROBE_PORT` (default `9000`). A malformed value —
`PORT=abc`, `PORT=` — is a `ConfigInvalid` the kernel reports as a
`startFailed` event and exit code `78`, sysexits(3)'s `EX_CONFIG`; nothing in
this package validates, prints or exits.

It is typechecked by the gate rather than executed by it: the example packages
are source-only — no build step, `main` pointing straight at `src/` — so there
is no compiled entry for `node` to run, and every spec drives `start` directly.
