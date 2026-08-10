# `@btravstack/start` example: an HTTP API

A real `node:http` `Runtime` serving a small order API, wired with
`@btravstack/di` and returning `Result` values from `unthrown`.

It is the answer to "what does the kernel actually ask of me?": a runtime is
three methods, and everything HTTP-shaped — routing, status codes, JSON — lives
in this package, not in `@btravstack/start`.

```
src/app.ts           the application module: ports, providers, domain errors
src/http-runtime.ts  the Runtime over node:http
src/index.ts         the process entry point: start + runMain
```

## The three methods

```ts
export const httpRuntime = (
  options: HttpRuntimeOptions,
): Runtime<typeof Router> => ({
  name: "http",
  needs: [Router],
  start: (host) => listen(host, options),
});
```

- **`start(host)`** binds the socket and resolves a `Serving`. `host.ctx` is the
  application context narrowed to the runtime's declared `needs`, so
  `host.ctx.get(Router)` is the one lookup this runtime performs — and a module
  that does not export `Router` fails to compile at the `start(...)` call site
  (see `src/needs-gate.test-d.ts`). A bind failure is a modeled
  `Err(RuntimeStartFailed)`, never a throw.
- **`Serving.drain(signal)`** stops _accepting_. It closes the listener and the
  idle keep-alive connections and returns immediately; requests already in
  flight keep running. It returns `void` because the kernel — the only party
  that can see the unit registry — owns the drain arithmetic.
- **`Serving.stop()`** closes for good and destroys the sockets it tracked while
  serving. Without that, `server.close()` waits on every keep-alive connection
  and shutdown hangs.

## A unit per request

```ts
host.run(
  { kind: "http", id: `${method} ${path}`, traceId: traceIdOf(request) },
  (_ctx, signal) => serve(handler, request, response, okStatus, signal),
);
```

`host.run` opens a unit, which is what makes the request countable during a
drain and what puts an ambient record (`currentUnit()`) in scope for everything
the handler touches — the `Logger` adapter reads it, so each request's log lines
carry its own trace id. An unknown route replies 404 _without_ opening one.

The response is written and flushed _inside_ the unit: the kernel counts a unit
as completed the moment its work settles, and `stop()` destroys sockets, so
returning before the flush would race the response away.

## `Result` → status happens here

The kernel never sees a status code, and this file never sees a `try`/`catch`:

```ts
outcome.match({
  ok: (value) => respond(response, okStatus, value),
  errCases: (matcher) =>
    matcher
      .with(P.tag("DuplicateOrder"), (error) =>
        respond(response, 409, { error: error._tag }),
      )
      .with(P.tag("OrderNotFound"), (error) =>
        respond(response, 404, { error: error._tag }),
      ),
  defect: () => respond(response, 500, { error: "InternalError" }),
});
```

Every error case is named. There is no `P._`: when the application grows a third
error, this match stops compiling until an arm decides its status. A `Defect` —
an unmodeled failure, including a handler that threw — is a 500 and only a 500,
which is the whole reason it is a separate channel.

| request                                      | status |
| -------------------------------------------- | ------ |
| `POST /orders` `{"id":"o-1","quantity":2}`   | `201`  |
| `GET /orders/o-1`                            | `200`  |
| `POST /orders` with an id already placed     | `409`  |
| `GET /orders/missing`                        | `404`  |
| any other path                               | `404`  |
| a handler that threw                         | `500`  |
| in-flight work aborted at the drain deadline | `503`  |

## Running it

```bash
pnpm --filter @btravstack/start-example-http-api test        # 13 specs
pnpm --filter @btravstack/start-example-http-api test:types  # the needs gate
```

`src/index.ts` boots the application the way a deployment would — `start` into
`runMain`, listening on `PORT` (3000 by default) — and `runMain` turns the
`ExitReport` into a process exit code: `0` clean, `1` a startup failure, `2`
drained with work abandoned, `70` a crash or a defect. The example is
type-checked and exercised by the specs rather than built: these sources use
NodeNext `.js` specifiers, which node's type stripping does not resolve back to
`.ts`, so running the entry point directly needs a build step or a
TypeScript-aware loader.
