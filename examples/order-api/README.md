# `@btravstack/core` example: the order API layer

The transport. A router implementing
[`order-api-contract`](../order-api-contract), provided as a port and served
under the kernel's lifecycle by [`@btravstack/http-server`](../../packages/http-server). One
stack, all of it in the graph: oRPC owns the contract, `@unthrown/orpc` owns
the `Result` bridge, the `http` starter owns oRPC's node adapter and the
socket, and the router itself is a di-provided service. The contract lives in
its own package, because a client needs it and needs none of this.

```text
src/auth.ts                           the two schemes (user, service), their authenticators, and the one api = defineHttp({ authenticators }) call
src/slices/orders/controller.ts       api.OrpcController(contract, "orders")({ inject: { logger: Logger }, unit: { place: PlaceOrder, find: FindOrder, list: ListOrders }, sync }) — where the orders slice's own domain error becomes an ORPCError
src/slices/orders/authorize.ts        exportable(caller, order) — the authorization rule, and renderCsv, which nothing but its answer reaches
src/slices/orders/module.ts           OrdersSlice — provides the controller and the orders fragment, exports both
src/slices/customers/controller.ts    api.OrpcController(contract, "customers")({ inject: { find: FindCustomer }, sync }) — same shape, for the customers slice's own domain error
src/slices/customers/module.ts        CustomersSlice — same shape as OrdersSlice
src/request-scope.ts                  RequestModule, UserModule, ServiceModule — the three unit kinds HttpModule binds; the answerers fork one per request
src/client.ts                         an AsyncResult client for the same contract
src/module.ts                         OrderApi — the composition root: orderRouter = api.OrpcRouter(contract)([ordersController, customersController]), then HttpModule("OrderApi")({
  needs: [Env], router: orderRouter, … })
src/main.ts                           the process: runMain(OrderApi, { onEvent: kernelEvents(…) })
src/__tests__/test-fixtures.ts                  boot / serve / clientFor / gate / recording, as Vitest fixtures — boot from @btravstack/testing
```

Each slice owns its contract fragment and its controller, and both are backed
by the same three-package vertical — [use cases](../order-application),
[entities](../order-domain), [Prisma adapters](../order-infrastructure). The
root only composes them — see
[Split a router into controllers](https://btravstack.github.io/btravstack/how-to/split-a-router-into-controllers).

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
`.result(...)` handler, which `api.OrpcController` attaches for you inside each
slice's controller — and that is what performs the elimination; the
`mapErrCases` inside it is the triage point — the boundary where the
application's vocabulary stops:

```ts
context.unit.place
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

## The transport is `@btravstack/http-server`, all of it

Binding the socket, one unit per request, the drain that retires a busy
keep-alive connection, the trace-id policy, oRPC's node adapter mounted under
`/rpc` all live in [`@btravstack/http-server`](../../packages/http-server) —
see its README for the guarantee it makes and the one way it answers HTTP.
What this example writes is two slices, each an `api.OrpcController(contract, path)({ inject: { name: Dep }, sync })`
over its own contract fragment, and a root router composed by the **array**
`api.OrpcRouter(contract)([ordersController, customersController])` —
contract-first, exact over the contract's procedures (a missing slice, a path
the contract does not declare, or a piece under the wrong path — impossible by
construction, since the path rides its own port id — are all compile errors,
the last two at the piece's own mint)
— each procedure a plain `Result`-returning function typed by the fragment,
built from the use cases its own controller declares — and a composition
root that is a `Module(...)` which also knows about it:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

There is **no authenticator to list**. The contract marks its `orders`
fragment, so the router declares one dependency per scheme that fragment names
— `HttpAuthenticator:user` and `HttpAuthenticator:service` — and carries the
providers that discharge them, which `HttpModule` puts in `provides` itself. A
scheme with nobody behind it is an unmet dependency `start` refuses, naming the
port. Both are ordinary providers, so an authenticator that declares a need of
its own carries it into the graph, refused at this very call if nothing
satisfies it. `Env` is the one need never yours to declare: `userAuth` binds
its three `HTTP_JWT_*` variables from it, and `HttpModule` carries `Env` for
every provider in the root.

Where the schemes are **declared** is `src/auth.ts`:

```ts
export type Identity = { readonly tenantId: TenantId; readonly userId: string };
export type ServiceIdentity = { readonly appId: string; readonly tenantId: TenantId };

// `principal` is the one place a claim becomes a tenant, and the one place
// this deployment names the claim it reads it from. Nothing is pinned, so
// `jwks`, `issuer` and `audience` bind from the three `HTTP_JWT_*` variables.
export const userAuth = jwtAuthenticator<Identity>()({ principal, scopes: ["orders:export"] });

// A key is cut FOR a tenant, so the tenant is stated on the entry — a second
// key states its own rather than inheriting the first's rows.
export const serviceKeys = [{ key: "reporting", principal: { appId: "reporting", tenantId } }] as const;
export const serviceAuth = apiKeyAuthenticator<ServiceIdentity>()({ keys: serviceKeys });

export const api = defineHttp({
  authenticators: { user: userAuth, service: serviceAuth },
});
```

**The contract says which schemes protect a route and which scopes each must
grant; `defineHttp({ authenticators })` says what each one resolves to.** The
contract names no identity type at all, so nothing
here reaches a client and enriching it — roles, an org tier, an internal id —
is never a contract change. Both slices mint their controller from that one
`api`, and the orders controller reads
`context.principal.userId` to log who asked for a placement. Who placed an
order is a transport-boundary fact, so it is logged there rather than pushed
through a use case that has no business with it.

`api` is held as **one binding and never destructured**: each destructured
member expands to a type mentioning the marker's inaccessible `unique symbol`
(TS2527), while held whole it collapses to the nameable `Http<A>` — which is
why this file carries no type annotation at all.

It is also the only way to read a principal: a marked fragment reached
through any other `defineHttp` call types
`principal: never`, so every read of it is a compile error. And it is written
once per application rather than per slice — a handler's parameter types are
fixed where the arrow is written, so the composition root cannot re-type a
`sync` callback living in a slice's module.

The root is a list of **slices**. The orders one owns its piece of the surface
and its triage, and no vertical at all — the use cases its leaves read are
built per request, in the `user` kind's module:

```ts
export const OrdersSlice = Module("OrdersSlice")({
  // The controller writes a line itself, so `Logger` is this slice's own
  // provider's need. The use cases are not: a leaf reaches them off
  // `context.unit`, never through `inject`.
  needs: [Logger],
  provides: [ordersController, orderRowFragment],
  exports: [ordersController, orderRowFragment],
});
```

The customers slice still imports its own pair — `CustomerApplicationModule`
and `CustomerPersistenceModule` — because its procedures are unmarked: they
open an anonymous unit, which has no principal to take a tenant from, so the
tenant arrives on the input and the repository stays in the application scope.
That asymmetry is the tenancy showing through the composition, and it is why
the root also imports `OrderPersistenceModule`: the outbox and the one Prisma
client live there, and the per-request repository is built over that client
rather than a client of its own.
`exports` takes the provider itself, not `ordersController.port`:
`api.OrpcController` minted that port, so there is no class to spell back off it.

`HttpModule` is sugar over the same primitives: it imports the starter
(`http()` — the whole surface), provides the
router and exports `HttpRuntime`, and returns exactly the di module
`Module("OrderApi")({ imports: [OrdersSlice, CustomersSlice, observability(),
http()], provides: [orderRouter], exports: [HttpRuntime, Logger] })` would
have. `observability()` is the starter that provides the
`Logger` the use cases and the request scope write to — `LOG_LEVEL` bound from
the environment, one JSON object per line on stdout, and every line stamped
with the unit the runtime opened around it. It is exported because every unit
kind reads it once forked, as `OrderDatabase` is. The runtime provider depends on the router port
through di, so even the transport wiring exists because the composition root
said so — a composition that imports the starter without providing
`orderRouter` carries an unmet need
`start` refuses (`needs-gate.test-d.ts` pins it with the hand-written form) —
and oRPC's own context stays empty, since one container is enough. `port` is
read back off `Serving.info` the same way any caller of the package does.

### One unit per call

The unit's lifetime **is** the response's: `@btravstack/http-server` keeps it open
until the response completes, so there is no seam for a late write to land in.
An unmatched path is the starter's 404; a defect inside a procedure is oRPC's own
`INTERNAL_SERVER_ERROR` collapse — nothing left to dispatch or end by hand.
The router itself needs nothing per request, so it lives at application scope;
what does is forked by each answerer, below.

### A request scope over the application scope

The application scope is opened once, by the kernel, and holds the database.
Opening another per request would give every request its own connection pool —
so the **answerer forks**: the module bound for the KIND that authenticated the
request is layered as a short-lived scope over the one already built, through
`UnitHost.fork`, and a request-scoped provider reads what the parent
constructed instead of rebuilding it. `RequestSpan`'s `onStop` runs while the
unit is still open, which is what gives its line the request's own trace id —
and no handler code manages any of it.

There are three kinds here, bound on `HttpModule`'s own `unit` option:

```ts
unit: { anonymous: RequestModule, user: UserModule, service: ServiceModule }
```

`RequestModule` is the base every request gets. `UserModule` is where the
tenant enters the graph — `Tenant` provided from the principal the `user`
scheme resolved, and the orders vertical composed over it, so `PlaceOrder`,
`FindOrder` and `ListOrders` are bound to that tenant before any handler runs.
`ServiceModule` is the same shape over the tenant the caller's API key was
**cut for**: `Tenant` from `auth.principals.service`, exactly as the `user`
kind takes it from its own principal. A key is cut for a tenant the way a login
belongs to one, so the tenant is a field of `ServiceIdentity` stated per key in
`auth.ts`'s `serviceKeys` — a second key states its own or does not compile. It
exports `FindOrder` and neither of the other two, which is what makes
`context.unit.place` and `context.unit.list` unreadable from `export`, the one
leaf both schemes serve: the record a leaf is given is the intersection of what
its kinds export.

### Three layers of authorization, and only the third is written by hand

`orders.export` is where all three meet. The **contract** says a `user` needs
`orders:export` (or a `service` key needs nothing), and the starter refuses an
under-scoped caller before a handler runs. The **unit** binds the tenant, so
`context.unit.find` cannot reach another tenant's order however the handler is
written. What is left is a decision about **this** order for **this** caller,
and that is `slices/orders/authorize.ts`:

```ts
export const exportable = (
  caller: Caller,
  order: Order,
): Result<Authorized<Order>, Forbidden> => …;

export const renderCsv = (order: Authorized<Order>): string => …;
```

`Authorized<T>` is branded with a symbol the module does not export, so
`exportable` is the only thing that can mint one and `renderCsv(order)` on a
plain order does not compile: the operation cannot be performed without the
decision. `Forbidden` is this application's own tagged error, folded by the
same exhaustive `mapErrCases` as every other — there is no framework `Policy`
port, no registry, and nothing to register.

The rule here is a quantity ceiling: a `service` caller exports anything, a
`user` only an order under `USER_EXPORT_CEILING`. It is a ceiling rather than
ownership because this domain records no owner — a worker places orders with
nobody behind them — and the shape is the same either way once yours does.

## The client half

```ts
const client = createOrderApiClient("http://127.0.0.1:3000", "/rpc", {
  authorization: `Bearer ${accessToken}`,
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
and lands in `defect` rather than `errCases`. A caller whose token is valid but
lacks a scope the procedure named gets a `FORBIDDEN` instead, on the same
channel — which is why the token above carries `orders:export`, the scope
`orders.export` requires of a `user`; a caller presenting the `service` scheme
(`x-api-key`) reaches that one procedure with no scope at all. A caller that
clears the scope and is refused by the rule below gets a `FORBIDDEN` too — but
that one the contract declares, so it carries `data: { id, reason }` and lands
in `errCases`. Same status, two channels. `customers` is
unmarked and
answers either way — and names its tenant on the input, which `orders` does
not: the tenant a marked procedure serves is the token's, so there is nothing
for the caller to say about it.

The error channel is the raw `ORPCError` union discriminated by `code` — not
re-wrapped into a second error concept — so the client's match is the mirror of
the server's `mapErrCases`.

## Running it

```bash
pnpm --filter @btravstack/example-order-api test
```

The specs run against a real HTTP server and a real oRPC client — genuine JSON
serialization, which is where the defect collapse to `INTERNAL_SERVER_ERROR`
actually happens. They need the Docker daemon, for the shared Postgres and
Redis `internal/test-infra` starts.

Every helper they need is a Vitest fixture in `src/__tests__/test-fixtures.ts`, so the spec
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

`serve` boots whatever composition it is handed with that `env` — the real
`OrderApi` included, since `http()` reads its
port from the environment the kernel provides — the unit kinds are forked by
the answerers themselves, per `OrderApi`'s own `unit` option, not by anything
`serve` supplies — and `clientFor` reads the port
it got back from `runtimeInfo()`.

`src/main.ts` is the process itself, and it is one call:

```ts
await runMain(OrderApi, {
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

const ordersContract = authenticated({ user: [] })({
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<OrderView>())
    .errors({
      INVALID_QUANTITY: { data: type<OrderRef>() },
      BAD_REQUEST: { data: type<{ readonly id: string }>() },
      CONFLICT: { data: type<OrderRef>() },
    }),
  …
});
```

The `customers` controller hands `input.tenantId` straight to the use case,
which hands it to the repository, which puts it in the `WHERE`. The `orders`
fragment is marked `authenticated({ user: [] })`, so a request under it opens
the `user` unit, whose `Tenant` is provided from the `user` scheme's principal —
this deployment's `Identity`, which the contract never names — and the use cases
the controller reads off `context.unit` were built over it. Its inputs name no
tenant: a required field the
handler ignores is a field that lies, and a caller that could name a tenant it
is not served is a confused deputy waiting to happen. Either way
`@btravstack/http-server` knows
nothing about tenants and has no hook for them — context is the application's
to own, and a starter that read a tenant off a header would be deciding a
system's authentication model on its behalf.

The contrast between the two fragments is the lesson. Where nothing
authenticates the caller, the tenant is an **argument**: the client cannot
forget it (the contract refuses), the router cannot invent one, and the path
from wire to `WHERE` is visible in three files. Where the caller is
authenticated, the tenant is **who is asking**, and it comes off the principal
— which is a contract change, exactly the kind of change that should be one.
`orders` has made it and `customers` has not, which is why one controller reads
its use cases off the unit and the other injects one, and why only one of the two inputs
mentions it.

It is typechecked by the gate rather than executed by it: the example packages
are source-only — no build step, `main` pointing straight at `src/` — so there
is no compiled entry for `node` to run, and every spec drives `start` directly.
