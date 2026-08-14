# `@btravstack/start-core` example: the order API layer

The transport. A router implementing
[`order-api-contract`](../order-api-contract), served over `node:http` under
the kernel's lifecycle by [`@btravstack/start-http`](../../packages/start-http).
The contract itself lives in its own package, because a client needs it and
needs none of this.

```
src/router.ts         the implementation, and the one place a domain error becomes an ORPCError
src/request-scope.ts  RequestModule — a scope forked per request over the application's
src/handler.ts        apiHandler — the per-request forkScope, handed to httpRuntime
src/client.ts         an AsyncResult client for the same contract
src/api-runtime.ts    orderApiRuntime — httpRuntime, with its port read from the graph
src/config.ts         httpConfig / probeConfig — @btravstack/config declarations
src/module.ts         OrderApiModule — the composition root
src/main.ts           the process: Config.parse + start + runMain
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

## The transport is `@btravstack/start-http`

Binding the socket, one unit per request, the drain that retires a busy
keep-alive connection, and the trace-id policy all live in
[`@btravstack/start-http`](../../packages/start-http) now — see its README for
the runtime contract and the guarantee it makes. This example supplies only
`apiHandler`, the function the package calls once per request, and reads
`port` back off `Serving.info` the same way any caller of the package does.

### One unit per call

```ts
export const apiHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context<InstanceType<ApiNeeds>>,
): AsyncResult<unknown, never> =>
  Module.forkScope(ctx, RequestModule, (scope) =>
    fromSafePromise(
      handler.handle(request, response, { prefix: PREFIX, context: { scope } }),
    ),
  );
```

The unit's lifetime **is** the response's: `@btravstack/start-http` keeps it
open until the response completes, so there is no seam for a late write to
land in. An unmatched or failing call is answered by the package itself
(`404` NotFound / `500` InternalError), so there is nothing left here to
dispatch or end by hand — `apiHandler` only has to fork the request scope and
hand the request to oRPC.

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
pnpm --filter @btravstack/start-example-order-api test  # the 15 api specs
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

## The configuration

Two [`@btravstack/config`](../../packages/config) values, and no `env.ts`:

| Variable     | Declared in                     | Default | What it is             |
| ------------ | ------------------------------- | ------- | ---------------------- |
| `HTTP_PORT`  | `httpConfig` (`src/config.ts`)  | `3000`  | the port the API binds |
| `PROBE_PORT` | `probeConfig` (`src/config.ts`) | `9000`  | `/livez` / `/readyz`   |

> **`HTTP_PORT` was `PORT`.** It is the one name this deployment changed, and
> not by choice: a config's variables are `PREFIX_KEY`, and no prefix and key
> join to a bare `PORT`. Every other variable in `examples/` is byte-for-byte
> what it was.

Each declaration is **one value that is both a port token and the module
serving it**, so `imports: [httpConfig]` provides it and `ctx.get(httpConfig)`
reads it back. `main.ts` never learns what a port is: `orderApiRuntime`
(`src/api-runtime.ts`) declares `httpConfig` in its `needs` and resolves it
from the context `start` hands it, then builds `@btravstack/start-http`'s
runtime with what it found.

`src/main.ts` is the process itself — and it validates **every** config in the
graph before building it, reporting them together:

```ts
await Config.parse(Config.collect(OrderApiModule), process.env).match({
  ok: () =>
    runMain(
      start(OrderApiModule, {
        runtime: orderApiRuntime(),
        probes: { port: probePort },
      }),
    ),
  errCases: (matcher) =>
    matcher.with(P.tag("config/ConfigInvalid"), (error) =>
      abort(describeIssues(error.issues)),
    ),
  defect: (cause) =>
    abort(`the configuration could not be validated: ${String(cause)}`),
});
```

`ConfigInvalid` is a `TaggedError`, so the matcher names it. The fold this
replaced reported one schema's issues and needed a `P._` escape hatch behind a
lint-disable, because a `SchemaIssues` array is a single type with no
discriminant to enumerate. And the report now covers the whole graph: an
operator who mistyped three variables across two packages learns all three
from one failed boot.

`probePort` is the one variable still read from `process.env` by hand: `start`
binds the probe server before it builds the graph, so its port cannot come out
of one. It is still declared and still validated above — see the comment at
that line, and phase 2's kernel integration.

A port is a **non-empty string piped into a coercion**, never a bare
`z.coerce.number()` — `@btravstack/config/zod`'s `port(fallback)` is that
fragment, and its own docs carry the reasoning: coercion is `Number()`
underneath, so `HTTP_PORT=` would bind the ephemeral port `0` and the bounds
cannot catch it, because a port's `min` **is** `0`.

It is typechecked by the gate rather than executed by it: the example packages
are source-only — no build step, `main` pointing straight at `src/` — so there
is no compiled entry for `node` to run, and every spec drives `start` directly.
The specs bind `port: 0` through `httpRuntime` directly, because an ephemeral
bind read back off `Serving.info` is a property of the test rather than of the
deployment; `src/needs-gate.test-d.ts` is what covers `orderApiRuntime`.
