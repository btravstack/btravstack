# `@btravstack/start` example: the order API layer

The transport. An oRPC contract, a router, and a `Runtime` that serves them over
`node:http` under the kernel's lifecycle.

```
src/contract.ts       the oRPC contract — the wire shapes and the declared error codes
src/router.ts         the implementation, and the one place a domain error becomes an ORPCError
src/request-scope.ts  RequestModule — a scope forked per request over the application's
src/orpc-runtime.ts   the Runtime: start / drain / stop
src/client.ts         an AsyncResult client for the same contract
src/module.ts         OrderApiModule — the composition root
src/env.ts            process.env validated through a schema, as a Result
src/main.ts           the process: readEnv + start + runMain
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

`handlerResult` performs that elimination, and the `mapErrCases` in front of it
is the triage point — the boundary where the application's vocabulary stops:

```ts
context.scope
  .get(PlaceOrder)
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

## The runtime's three methods

- **`start`** binds the socket and hands back a `Serving`. A bind failure is a
  modeled `Err(RuntimeStartFailed)`, never a throw.
- **`Serving.drain(signal)`** stops _accepting_: it closes the listener and the
  idle keep-alive connections, and leaves requests already in flight to run to
  completion. The kernel's deadline signal has nothing to cancel here — the
  in-flight units are the kernel's to time out.
- **`Serving.stop()`** closes for good and **destroys** every remaining socket.
  `node:http`'s `close()` waits out keep-alive connections, so without the socket
  set the process would never exit.

### `Serving.info`, not an `onListening` hook

The runtime binds `port: 0` in every spec and publishes what it got:

```ts
const info = (await app.runtimeInfo()).get(); // { port, prefix }
```

`Serving.info` is the kernel's channel for exactly this, which is why there is
no `onListening` callback and no `boundPort()` accessor to keep in sync.

### One unit per call

```ts
host.run(metaFor(request), (ctx, _signal) =>
  Module.forkScope(ctx, RequestModule, (scope) =>
    fromSafePromise(
      handler.handle(request, response, { prefix, context: { scope } }),
    ),
  ),
);
```

Two things in there are easy to get wrong:

- **`UnitMeta.id` is minted per request**, not set to the route. `traceId`
  defaults to `id`, so a category there would give every request the same trace
  id and silently defeat the ambient record. An inbound `x-request-id` becomes
  the `traceId` — the correlation id is the one an outside caller may choose.
- **The response is flushed inside the unit.** oRPC's `handle` resolves only
  once the response has closed, so the unit stays open until the bytes are on
  the wire. Returning first and writing afterwards races `stop()` destroying the
  socket.

### A request scope over the application scope

The application scope is opened once, by the kernel, and holds the database.
Opening another per request would give every request its own empty in-memory
database — so the runtime **forks**: `Module.forkScope` layers a short-lived
scope over the one already built, and a request-scoped provider reads what the
parent constructed instead of rebuilding it. `RequestSpan`'s `onStop` runs while
the unit is still open, which is what gives its line the request's own trace id.

## The client half

```ts
const client = createOrderApiClient("http://127.0.0.1:3000");

const named = (await client.orders.place({ id, quantity })).match({
  ok: () => "placed",
  errCases: (matcher) =>
    matcher
      .with({ code: "INVALID_QUANTITY" }, (error) => error.code)
      .with({ code: "CONFLICT" }, (error) => error.code),
  defect: () => "bug",
});
```

The error channel is the raw `ORPCError` union discriminated by `code` — not
re-wrapped into a second error concept — so the client's match is the mirror of
the server's `mapErrCases`.

## Running it

```bash
pnpm --filter @btravstack/start-example-order-api test  # 8 runtime specs + 4 env specs
```

The specs run against a real HTTP server and a real oRPC client — genuine JSON
serialization, which is where the defect collapse to `INTERNAL_SERVER_ERROR`
actually happens. No Docker, nothing to install.

`src/main.ts` is the process itself — and it reads its configuration the same way
it reads everything else, as a value:

```ts
await readEnv().match({
  ok: (env) =>
    runMain(
      start(OrderApiModule, {
        runtime: orpcRuntime({ port: env.PORT }),
        probes: { port: env.PROBE_PORT },
      }),
    ),
  errCases: (matcher) =>
    matcher.with(P._, (issues) => abort(describeEnvIssues(issues))),
  defect: (cause) =>
    abort(`the environment could not be validated: ${String(cause)}`),
});
```

`src/env.ts` is where `PORT` and `PROBE_PORT` are validated. It goes through
`@unthrown/standard-schema`'s `fromSchema` rather than a schema's own `.parse()`,
because `.parse()` throws — which `unthrown/no-throw` bans, and which would
contradict the example it appears in. The issues are the modeled `E`, folded
above into a message and a non-zero exit code.

The schema reads **strings**, not `z.coerce.number()`: coercion is `Number()`
underneath, so `PORT=abc` would bind `NaN` and `PORT=` would bind `0`, the
ephemeral port. A malformed value is a validation issue instead.

It is typechecked by the gate rather than executed by it: the example packages
are source-only — no build step, `main` pointing straight at `src/` — so there
is no compiled entry for `node` to run, and every spec drives `start` directly.
