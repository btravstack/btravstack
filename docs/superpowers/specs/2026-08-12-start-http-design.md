# `@btravstack/start-http` — the HTTP runtime — Design

**Date:** 2026-08-12
**Status:** Approved, pending implementation plan
**Repo:** `btravstack/start`
**Scope:** the first of the three deferred runtime packages. `-amqp` and
`-temporal` are explicitly **not** in this document; each gets its own
spec → plan → implementation cycle.

## Purpose

`CLAUDE.md` has carried `@btravstack/start-http` in its "Deferred, deliberately"
list since the kernel shipped, described as "routing, middleware, `Result` → HTTP
status". This document deliberately **rejects two thirds of that description**.

Routing and middleware are solved by oRPC, Hono, Express and half a dozen
others. The thing `examples/order-api` proved genuinely hard was none of them —
it was the **lifecycle**: one unit per request, flushing the response inside that
unit, and a drain that actually stops accepting. Two of the defects found in the
2026-08-12 review were in exactly that code, and one of them
(`closeIdleConnections()` not reaching a busy keep-alive connection) was invisible
to every test until a raw socket was pointed at it.

So the package owns the part **only the kernel's neighbour can own**, and
nothing else. It is the answer to "how do I serve HTTP under this lifecycle",
not "how do I write a web application".

## Decisions

Four decisions were taken during design, each with its alternatives considered.

1. **Lifecycle only; the caller brings the handler.** Not a router, not a
   middleware chain. `Result` → HTTP status is a **non-goal for v1**: it is one
   `mapErrCases` in the caller's own code, it differs per API style, and shipping
   a mapping nobody asked for is how a lifecycle package becomes a framework.
2. **A request's unit closes when the response completes**, not when the
   handler's promise settles. This turns the kernel's least-checkable contract —
   "flush the response INSIDE the unit" — from documentation into structure.
3. **The package mints `UnitMeta`, with no knobs.** `kind: "http"`,
   `id: randomUUID()` always, and `traceId` set to the **trimmed** value of
   `x-request-id` only when that value is a non-empty string. Both documented
   footguns — a route template as `id`, and a blank header winning over the
   minted id — become unreachable.
4. **`examples/order-api` migrates onto the package.** It keeps its oRPC router
   and loses its hand-rolled transport, so the package gains a real consumer
   inside the gate — this repo's own standard for what `examples/` is for.

## Public surface

```ts
export type HttpInfo = { readonly port: number };

export type HttpHandler<Needs extends AnyPort> = (
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context<InstanceType<Needs>>,
  signal: AbortSignal,
) => PromiseLike<unknown>;

export type HttpOptions<Needs extends AnyPort> = {
  /** `0` lets the OS pick — read it back from `RunningApp.runtimeInfo()`. */
  readonly port: number;
  /** Default `0.0.0.0`: the deployment target is a pod. */
  readonly hostname?: string;
  readonly needs: readonly Needs[];
  readonly handler: HttpHandler<Needs>;
};

export const httpRuntime = <Needs extends AnyPort>(
  options: HttpOptions<Needs>,
): Runtime<Needs, HttpInfo>;
```

- **`needs` is a value, not an inference from the handler.** `Runtime.needs` is
  a real array the kernel reads; TypeScript infers `Needs` from it, which then
  types `ctx` inside the handler. One declaration, both jobs — and it is what
  keeps `start`'s phantom needs-gate meaningful at the call site.
- **The handler must return something awaitable — `PromiseLike<unknown>`, not
  `void`.** This is narrower than `UnitWork`'s union and deliberately so. A
  `void`-returning handler that writes asynchronously gives the package no way
  to know it is unfinished, so the fallback below would fire a premature `404`
  over a response still being written. Requiring an awaitable keeps the
  package's guarantee unconditional rather than
  true-unless-you-return-void. Both target libraries already comply:
  oRPC's `handle` and Hono's request listener each return a promise. A plain
  `(req, res) => void` handler is one `async` keyword away.
  `unknown` rather than `void` because oRPC's `handle` resolves
  `{ matched: boolean }`; the value is used only to decide the fallback, never
  as the unit's result. `AsyncResult` satisfies `PromiseLike`, so it is accepted
  without being named.
- **`hostname` earns its keep** where it did not in the example: a container
  needs `0.0.0.0` and a laptop wants `127.0.0.1`, so real callers set it.

## Compatibility

Verified against the shipped type definitions, not assumed.

| Library              | Fit                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **oRPC**             | `RPCHandler.handle(request: NodeHttpRequest, response: NodeHttpResponse, …): Promise<…>` — node req/res in. `examples/order-api` already passes `IncomingMessage`/`ServerResponse` into it and typechecks.                                                                                                                                                                                                                   |
| **Hono**             | `@hono/node-server@2.1.0`'s `getRequestListener(fetch)` returns `(IncomingMessage \| Http2ServerRequest, ServerResponse \| Http2ServerResponse) => Promise<void>`. It accepts a _wider_ union than the handler is called with, so contravariance makes it directly assignable. Use `getRequestListener`, **not** Hono's `serve()` — `serve()` creates and owns its own server, which is the job this package is taking over. |
| **`@unthrown/orpc`** | Orthogonal. `handlerResult` from `@unthrown/orpc/server` sits inside a procedure, eliminating the `Result` into oRPC's own channels; it never sees the server.                                                                                                                                                                                                                                                               |

## Lifecycle

```
start(host)
  ├─ createServer(listener)              listener = one unit per request
  ├─ server.once("error", onBindError)   → Err(RuntimeStartFailed{runtime:"http"})
  ├─ try { server.listen(port, host) }   catch → same Err, never a Defect
  └─ on listening:
       swap onBindError for a permanent ignoring listener
       resolve Ok(Serving{ info: { port: address().port } })

per request:
  host.run({ kind: "http", id: randomUUID(), traceId? }, (ctx, signal) => {
    if (draining) closeAfterResponse(res)
    void handler(req, res, ctx, signal) → on settle, if res still open:
        rejected or defect → 500
        resolved           → 404
    return onceClosed(res)               ← the unit's lifetime
  })

drain(signal)  draining = true; mark every open response Connection: close;
               server.close(); server.closeIdleConnections(); OkAsync()

stop()         same stopAccepting (idempotent); destroy every socket; await "close"
```

**The package's guarantee, and the sentence its README should lead with:** every
request produces exactly one completed response, and its unit stays open until
that response is on the wire.

Three behaviours are carried over from defects this repo already paid for, moved
out of the example and into the package:

- **`Connection: close` on responses open when the drain begins.**
  `closeIdleConnections()` reaches only connections idle at that instant;
  measured on Node 22.19, a busy one survives and node serves further requests
  down it for the whole drain window. A response whose headers are already sent
  has its socket ended on `finish` instead.
- **The bind's synchronous throw is caught.** `listen` validates the port itself
  and throws `ERR_SOCKET_BAD_PORT` rather than emitting `'error'`; uncaught it
  becomes a `Defect` and bypasses the declared
  `AsyncResult<Serving, RuntimeStartFailed>`.
- **The server keeps an `'error'` listener for life.** Zero listeners turns a
  post-bind accept failure (`EMFILE`) into an unhandled `'error'`, which the
  kernel's `uncaughtException` handler escalates into killing the application.

Two deliberate non-obvious choices, both of which must carry their reasoning in
the code or a later reader will "simplify" them away:

- **`drain`'s `signal` is unused.** HTTP has nothing to escalate to: closing the
  listener is instantaneous, and the in-flight requests are the kernel's to time
  out and abort. Temporal's runtime must race `run()` against the deadline;
  this one has no second wait.
- **The socket is not `unref`'d.** The kernel's probe server is, because it must
  never be the reason a process stays alive. An application server is the
  opposite: it _is_ the reason.

## Error handling

| Failure                                      | Channel                                             |
| -------------------------------------------- | --------------------------------------------------- |
| Port in use, out of range, permission denied | `Err(RuntimeStartFailed{ runtime: "http", cause })` |
| Post-bind server `'error'`                   | Absorbed; never an uncaught exception               |
| Handler rejects, throws, or defects          | `500`, response ended, unit closes normally         |
| Handler resolves without responding          | `404`, same                                         |
| Response machinery itself fails              | Socket destroyed — a reset rather than a hang       |

The unit is typed `AsyncResult<void, never>`: the package folds every outcome
into a response, so nothing escapes into the kernel's error channel. Thesis #3
stays intact — the _kernel_ never maps an outcome to a transport, and the
mapping this package does stops here.

One consequence of decision 1 worth stating outright, because it looks like a
gap until you see it is the point: a handler that returns an `AsyncResult`
carrying an `Err` or a `Defect` **resolves** rather than rejects — an
`AsyncResult` never rejects — so it lands in the `404` branch, not the `500`
one. That is correct. This package does not map `Result` → status; folding a
domain failure into a response is the caller's job, and a handler that hands
back an unfolded `Result` has not answered the request.

## Testing

New code, so **all five test conventions bind** — not the exemption the kernel's
14 legacy specs carry. `describe` first, fixtures in `src/test-fixtures.ts`,
teardown in fixtures, GIVEN/WHEN/THEN, one deep assertion per test. Coverage at
100% lines/functions, matching `packages/start`. A real `node:http` server on
`port: 0`; no Docker, no network.

| Test                                                           | Why it is load-bearing                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| The unit stays open until the response is on the wire          | The reason for decision 2                                       |
| A busy keep-alive connection gets `Connection: close` on drain | Migrates with its raw-socket fixture; `fetch` cannot express it |
| A handler that returns without responding → `404`              | oRPC's `matched: false` path                                    |
| A handler that rejects → `500`, and the unit closes            | Failure cannot strand a unit                                    |
| An out-of-range port → `Err`, not a `Defect`                   | The synchronous-throw lesson                                    |
| A post-bind `'error'` is absorbed                              | It cannot kill the application                                  |
| An empty `x-request-id` does not become the trace id           | Shipped and fixed on 2026-08-12                                 |
| `port: 0` publishes the real port on `Serving.info`            | The reason `info` exists                                        |

## Package layout

```
packages/start-http/
  src/http-runtime.ts     bind / unit / drain / stop
  src/index.ts            the public surface
  src/test-fixtures.ts    keepAlive, serve — the extended `it`
  README.md
```

Peer dependencies only — `@btravstack/start`, `@btravstack/di`, `unthrown` —
and **zero runtime dependencies**, `node:` builtins alone. `engines: ">=20"`,
`files: ["dist"]`, `sideEffects: false`, dual CJS/ESM via tsdown,
`declarationMap: false`. The same posture as the kernel, for the same reasons.
Publishable, so it needs a changeset.

## Migrating `examples/order-api`

The example drops roughly 150 lines of `listen`/`drain`/`stop`/socket tracking
and keeps what it exists to teach: the oRPC router, the `Result` → `ORPCError`
mapping, the per-request `Module.forkScope`, and the contract split.

```ts
start(OrderApiModule, {
  runtime: httpRuntime({
    port: env.PORT,
    needs: [PlaceOrder, FindOrder, Logger],
    handler: (req, res, ctx) => rpc.handle(req, res, { context: { ctx } }),
  }),
});
```

Two consequences to handle deliberately rather than discover mid-migration:

- **`OrderApiInfo` loses `prefix`.** The package publishes `{ port }`;
  `{ port, prefix }` was the example's own shape. Three specs assert that pair,
  and `examples/README.md` uses "no two of the three `Info` shapes share a
  field" as a teaching point. `prefix` becomes a constant the example holds
  rather than something the runtime publishes; both places need updating.
- **The needs gate must survive unchanged.** `httpRuntime<Needs>` infers from
  the `needs` array, so `order-api/src/needs-gate.test-d.ts` must still compile
  and still fail correctly on a missing port. Exercising that gate is the stated
  reason `examples/` exists, so the migration is not done until that file passes
  untouched.

The "writing a runtime from scratch" lesson that `order-api` currently carries
moves to the package README's own _Writing a runtime_ section, where the root
README already points readers.

## Documentation to update

Per `CLAUDE.md`'s own sync rule, in the same commits as the code:

- `CLAUDE.md` — move `-http` out of "Deferred, deliberately"; correct the
  "routing, middleware, `Result` → HTTP status" description to what was built.
- Root `README.md` — the deferred-packages table, and the examples count if the
  workspace count changes.
- `examples/README.md` — the `Info`-shape teaching point.
- `examples/order-api/README.md` — the runtime's three methods section, now the
  package's.

## Out of scope

HTTPS and HTTP/2 (`node:http` only), routing, middleware, `Result` → status
mapping, body parsing, static files, and any option no caller sets — the last on
the evidence of the 2026-08-12 audit, which found five such options across the
three example runtimes.
