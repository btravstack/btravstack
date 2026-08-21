# `@btravstack/core` example: the order API layer

The transport. A router implementing
[`order-api-contract`](../order-api-contract), provided as a port and served
under the kernel's lifecycle by [`@btravstack/http`](../../packages/http). One
stack, all of it in the graph: oRPC owns the contract, `@unthrown/orpc` owns
the `Result` bridge, the `http` starter owns oRPC's node adapter and the
socket, and the router itself is a di-provided service. The contract lives in
its own package, because a client needs it and needs none of this.

```
src/auth.ts                           Identity, and the HttpController / HttpRouter / HttpAuthenticator httpAuth<Identity>() mints from it
src/authenticator.ts                  bearerAuthenticator — headers in, Identity out, on the starter's port
src/slices/orders/controller.ts       HttpController("OrdersController", contract.orders)({ place: PlaceOrder, find: FindOrder, logger: Logger }, { sync }) — where the orders slice's own domain error becomes an ORPCError
src/slices/orders/module.ts           OrdersSlice — provides the controller, exports only it
src/slices/customers/controller.ts    HttpController("CustomersController", contract.customers)({ find: FindCustomer }, { sync }) — same shape, for the customers slice's own domain error
src/slices/customers/module.ts        CustomersSlice — same shape as OrdersSlice
src/request-scope.ts                  RequestModule — passed as StartOptions.unit; the kernel forks it per request
src/client.ts                         an AsyncResult client for the same contract
src/module.ts                         OrderApi — the composition root: orderRouter = HttpRouter(contract)({ orders, customers }), then HttpModule("OrderApi")({
  needs: [Env], router: orderRouter, … })
src/main.ts                           the process: runMain(OrderApi, { unit: RequestModule, onEvent: kernelEvents(…) })
src/test-fixtures.ts                  boot / serve / clientFor / gate / recording, as Vitest fixtures — boot from @btravstack/testing
```

Each slice owns its contract fragment and its controller, and both are backed
by the same three-package vertical — [use cases](../order-application),
[entities](../order-domain), [Prisma adapters](../order-infrastructure). The
root only composes them — see
[Split a router into controllers](https://btravstack.github.io/start/how-to/split-a-router-into-controllers).

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
`.result(...)` handler, which `HttpController` attaches for you inside each
slice's controller — and that is what performs the elimination; the
`mapErrCases` inside it is the triage point — the boundary where the
application's vocabulary stops:

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
      // A malformed id is the caller's mistake, so 400 — not the 409 a
      // duplicate gets.
      .with(P.tag("InvalidOrderId"), (error) =>
        errors.BAD_REQUEST({ message: error.message, data: { id: error.id } }),
      )
      .with(P.tag("DuplicateOrder"), (error) =>
        errors.CONFLICT({ message: error.message, data: { id: error.id } }),
      ),
  );
```

Every case is named — this repo bans `P._`, and `mapErrCases` has no
`.otherwise()`. A new domain error is a compile error here, at the one slice
that has to decide what a client sees. A `Defect` is never named: it has no code
because it was never modelled, and collapsing it to a 500 is the correct
treatment rather than a fallback.

## The transport is `@btravstack/http`, all of it

Binding the socket, one unit per request, the drain that retires a busy
keep-alive connection, the trace-id policy, oRPC's node adapter mounted under
`/rpc` all live in [`@btravstack/http`](../../packages/http) —
see its README for the guarantee it makes and the one way it answers HTTP.
What this example writes is two slices, each an `HttpController(name, fragment)({ name: Dep }, { sync })`
over its own contract fragment, and a root router composed by the **keyed**
`HttpRouter(contract)({ orders: ordersController, customers:
customersController })` — contract-first, exact (a missing slice, a stray
key or a controller under the wrong key are all compile errors at that call)
— each procedure a plain `Result`-returning function typed by the fragment,
built from the use cases its own controller declares — and a composition
root that is a `Module(...)` which also knows about it:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  authenticator: bearerAuthenticator,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

`authenticator` is owed because the contract marks its `orders` fragment
`authenticated`: the router provider carries `AuthenticatorPort` as a need, so
omitting the line is an unmet dependency `start` refuses, and supplying one
minted on a different identity is a compile error at this call. It sits at
the root rather than in a slice — who a caller is is one answer per process —
and it is an ordinary provider, so swapping this example's
`Bearer <tenantId>:<userId>` stand-in for JWT verification changes nothing
else.

Where the identity is **stated** is `src/auth.ts`, the whole of it:

```ts
export type Identity = { readonly tenantId: TenantId; readonly userId: string };

const identity = httpAuth<Identity>();

export const HttpController: HttpControllerOf<Identity> =
  identity.HttpController;
export const HttpRouter: HttpRouterOf<Identity> = identity.HttpRouter;
export const HttpAuthenticator: HttpAuthenticatorOf<Identity> =
  identity.HttpAuthenticator;
```

**The contract says whether a route is protected; `httpAuth<Identity>()` says
what the principal is.** The contract names no identity type at all, so nothing
here reaches a client and enriching it — roles, an org tier, an internal id —
is never a contract change. Both slices import `HttpController` from there
instead of from `@btravstack/http`, and the orders controller reads
`context.principal.userId` to log who asked for a placement. Who placed an
order is a transport-boundary fact, so it is logged there rather than pushed
through a use case that has no business with it.

It is also the only way to read a principal at all: a marked fragment reached
through `@btravstack/http`'s own top-level `HttpController` types
`principal: never`, so every read of it is a compile error. And it is written
once per application rather than per slice — a handler's parameter types are
fixed where the arrow is written, so the composition root cannot re-type a
`sync` callback living in a slice's module.

The root is a list of **slices**. Each one imports the vertical it needs —
`OrderApplicationModule`, whose repository is an unmet need, and
`OrderPersistenceModule`, which provides it — and exports only its controller:

```ts
export const OrdersSlice = Module("OrdersSlice")({
  // The environment its persistence reads `DATABASE_URL` from, and the logger
  // its interactors write to — both the root's to supply, both named here.
  needs: [Env, Logger],
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [ordersController],
  exports: [ordersController],
});
```

So the root names what the process serves, not everything every slice happens
to depend on. The customers slice imports `CustomerApplicationModule` and
`CustomerPersistenceModule` — its own pair — so `FindCustomer` and the
customer repository are not in the orders graph, and `PlaceOrder` is not in
the customers one. The two meet on the internal database module both
persistence halves import, which is a diamond rather than duplication: di
flattens the module tree into a `Set` keyed by provider **reference**, so the
graph builds one database (measured on this composition — a naive walk visits
16 provider slots and di keeps 15, where the same walk over the pre-split
modules visited 22 for the same 15).
`exports` takes the provider itself, not `ordersController.port`:
`HttpController` minted that port, so there is no class to spell back off it.

`HttpModule` is sugar over the same primitives: it imports the starter
(`http()` — the whole surface), provides the
router and exports `HttpRuntime`, and returns exactly the di module
`Module("OrderApi")({ imports: [OrdersSlice, CustomersSlice, observability(),
http()], provides: [orderRouter], exports: [HttpRuntime, Logger] })` would
have. `observability()` is the starter that provides the
`Logger` the use cases and the request scope write to — `LOG_LEVEL` bound from
the environment, one JSON object per line on stdout, and every line stamped
with the unit the runtime opened around it. It is exported because the
per-request `RequestModule` reads it. The runtime provider depends on the router port
through di, so even the transport wiring exists because the composition root
said so — a composition that imports the starter without providing
`orderRouter` carries an unmet need
`start` refuses (`needs-gate.test-d.ts` pins it with the hand-written form) —
and oRPC's own context stays empty, since one container is enough. `port` is
read back off `Serving.info` the same way any caller of the package does.

### One unit per call

The unit's lifetime **is** the response's: `@btravstack/http` keeps it open
until the response completes, so there is no seam for a late write to land in.
An unmatched path is the starter's 404; a defect inside a procedure is oRPC's own
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
const client = createOrderApiClient("http://127.0.0.1:3000", "/rpc", {
  authorization: `Bearer ${tenantId}:${userId}`,
});

const named = (await client.orders.place({ id, quantity })).match({
  ok: () => "placed",
  errCases: (matcher) =>
    matcher.with(
      { code: "INVALID_QUANTITY" },
      { code: "BAD_REQUEST" },
      { code: "CONFLICT" },
      (error) => error.code,
    ),
  defect: () => "bug",
});
```

The header is not optional here: `orders` is the marked half of the contract,
so the same call without it is refused before any procedure runs — as an
`UNAUTHORIZED` the contract does not declare, which means it is not inferable
and lands in `defect` rather than `errCases`. `customers` is unmarked and
answers either way — and names its tenant on the input, which `orders` does
not: the tenant a marked procedure serves is the token's, so there is nothing
for the caller to say about it.

The error channel is the raw `ORPCError` union discriminated by `code` — not
re-wrapped into a second error concept — so the client's match is the mirror of
the server's `mapErrCases`.

## Running it

```bash
pnpm --filter @btravstack/example-order-api test  # 17 api specs
```

The specs run against a real HTTP server and a real oRPC client — genuine JSON
serialization, which is where the defect collapse to `INTERNAL_SERVER_ERROR`
actually happens. No Docker, nothing to install.

Every helper they need is a Vitest fixture in `src/test-fixtures.ts`, so the spec
opens on `describe` and each test names its dependencies in its own parameter
list. Shutting an app down is the `boot` fixture's job —
[`@btravstack/testing`](../../packages/testing)'s `bootFixture({ env: { PORT:
"0", HOST: "127.0.0.1", LOG_LEVEL: "fatal" } })`, which `serve` builds on — which is why no test
here has a `try`/`finally`: fixture cleanup runs even when the body fails, and a
shutdown that blows up (a `Defect` on `exited`) fails the test. The lines the
running app writes come back through `observability({ sink })` — the same seam
a deployment swaps for pino — so the trace assertions read `line.unit.traceId`
as a field instead of parsing a prefix out of a string, and the stub roots pass
a no-op sink so a spec run is not also a log dump.

```ts
it("lets an in-flight call finish while draining", async ({ serve, clientFor, gate }) => {
  // GIVEN a call held open inside the repository
  const app = serve(gate.api);
  …
});
```

`serve` boots whatever composition it is handed with `RequestModule` as the
unit and that `env` — the real `OrderApi` included, since `http()` reads its
port from the environment the kernel provides — and `clientFor` reads the port
it got back from `runtimeInfo()`.

`src/main.ts` is the process itself, and it is one call:

```ts
await runMain(OrderApi, {
  unit: RequestModule,
  onEvent: kernelEvents(createLogger(jsonSink())),
});
```

`onEvent` puts the kernel's nine lifecycle events in the same stream as the
application's own lines, instead of the kernel's default JSON on stderr — one
shape, one set of fields, one thing to search. The logger there is built **by
hand** rather than resolved from the graph, and it has to be: `building` is
emitted while the graph is still being constructed and `startFailed` when it
never finished, so a sink taken out of the context it is watching would have
nothing to write the two events that matter most with. This is the one example
that wires it, so the pattern is visible once; the other two `main.ts` files
stay a single line.

Configuration is read **inside the graph**: `http()` binds `PORT` (default
`3000`) and `HOST` (default `0.0.0.0`) from the `Env` port the kernel provides,
`observability()` binds `LOG_LEVEL` (default `info`),
`OrderPersistenceModule` binds `DATABASE_URL` (required — a migration aimed at
an unnamed database is a mistake worth failing on),
and the kernel binds its own `PROBE_PORT` (default `9000`). A malformed value —
`PORT=abc`, `PORT=` — is a `ConfigInvalid` the kernel reports as a
`startFailed` event and exit code `78`, sysexits(3)'s `EX_CONFIG`; nothing in
this package validates, prints or exits.

## Multi-tenant by design, not by framework

The API serves several tenants from one database, and the tenant is declared
in **its own contract** — on the unmarked fragment, where the caller is the
only one who can say which tenant is meant:

```ts
export type Tenanted = { readonly tenantId: string };

const customersContract = {
  find: oc
    .input(type<Tenanted & { readonly id: string }>())
    .output(type<CustomerView>())
    .errors({ NOT_FOUND: { data: type<{ readonly id: string }>() } }),
};

const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<OrderView>())
    .errors({
      INVALID_QUANTITY: { data: type<OrderRef>() },
      BAD_REQUEST: { data: type<{ readonly id: string }>() },
      CONFLICT: { data: type<OrderRef>() },
    }),
  …
};
```

The `customers` controller hands `input.tenantId` straight to the use case,
which hands it to the repository, which puts it in the `WHERE`. The `orders`
fragment is marked `authenticated`, so its controller takes the tenant from
`context.principal.tenantId` — this deployment's `Identity`, which the
contract never names — and its inputs name none: a required field the
handler ignores is a field that lies, and a caller that could name a tenant it
is not served is a confused deputy waiting to happen. Either way
`@btravstack/http` knows
nothing about tenants and has no hook for them — context is the application's
to own, and a starter that read a tenant off a header would be deciding a
system's authentication model on its behalf.

The contrast between the two fragments is the lesson. Where nothing
authenticates the caller, the tenant is an **argument**: the client cannot
forget it (the contract refuses), the router cannot invent one, and the path
from wire to `WHERE` is visible in three files. Where the caller is
authenticated, the tenant is **who is asking**, and it comes off the principal
— which is a contract change, exactly the kind of change that should be one.
`orders` has made it and `customers` has not, which is why the two controllers
read the tenant from different places and why only one of the two inputs
mentions it.

It is typechecked by the gate rather than executed by it: the example packages
are source-only — no build step, `main` pointing straight at `src/` — so there
is no compiled entry for `node` to run, and every spec drives `start` directly.
