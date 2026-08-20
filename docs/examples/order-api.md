---
title: Order API example
description: The HTTP deployment — two slices, orders and customers, one marked authenticated and one public, each its own contract fragment, HttpController and full vertical down to Prisma, an auth.ts stating what a principal is and an authenticator resolving it, composed by the keyed HttpRouter form into one HttpModule root, RequestModule forked per request, a main.ts that is one runMain call with the kernel's events on the application's own logger, and the five compile-time gates pinned by needs-gate.test-d.ts.
---

# Order API (HTTP)

[`examples/order-api`](https://github.com/btravstack/start/tree/main/examples/order-api)
— the first deployment: [the order application](/examples/order-application)
answering callers over oRPC, served by [`@btravstack/http`](/reference/http).

```sh
pnpm turbo run test --filter=@btravstack/example-order-api
```

The specs run a real `node:http` server and a real oRPC client over it, on an
ephemeral port; nothing else is needed.

## Two slices, each its own fragment and controller

The contract splits into two fragments, `orders` and `customers`, each a
`RouterContract` in its own right — and one of them is marked:

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const orderView = z.object({ id: z.string(), quantity: z.number() });
export type OrderView = z.infer<typeof orderView>;

const orderRef = z.object({ id: z.string() });
export type OrderRef = z.infer<typeof orderRef>;

// The unmarked fragment names its tenant on the input; the marked one does not,
// because a caller's identity establishes it there.
const tenanted = z.object({ tenantId: z.string() });

const customerView = z.object({ id: z.string(), name: z.string() });
export type CustomerView = z.infer<typeof customerView>;

// Same shape as `orderRef`, deliberately not the same schema: reusing it would
// type a customer id as "which order it was about".
const customerRef = z.object({ id: z.string() });
export type CustomerRef = z.infer<typeof customerRef>;

const ordersContract = {
  place: oc
    .input(z.object({ id: z.string(), quantity: z.number() }))
    .output(orderView)
    .errors({
      INVALID_QUANTITY: { data: orderRef },
      CONFLICT: { data: orderRef },
    }),
  find: oc
    .input(orderRef)
    .output(orderView)
    .errors({ NOT_FOUND: { data: orderRef } }),
};

const customersContract = {
  find: oc
    .input(tenanted.extend({ id: z.string() }))
    .output(customerView)
    .errors({ NOT_FOUND: { data: customerRef } }),
};

export const contract = {
  orders: authenticated(ordersContract),
  customers: customersContract,
};
```

The wire shapes are **zod schemas**, with the view types inferred from them
rather than declared beside them. They are not the entities: `Order`'s fields
are branded (`OrderId`, `Quantity`) and a brand is a compile-time fiction that
does not survive serialization, so the transport speaks its own shape and each
slice's controller is the one place the two are converted. oRPC's `type<T>()`
would say the same thing to the compiler and check nothing at runtime, which
is how `{ quantity: "abc" }` reaches a use case typed `number`; a schema is
what makes the boundary real, and inferring the type from it is what keeps
the checked shape and the compiled one from drifting.

The two fragments are module-private; `contract` and the view types are the
package's exports, and every consumer reaches a fragment through it —
`contract.orders`, `contract.customers`.

[`authenticated`](/reference/contract) on `orders` is a type-level fact about
the fragment, so a client reads which half of this API needs credentials off
the contract itself, and a server that serves the marked half without an
authenticator does not compile. It is also why the two fragments' inputs
differ: `customers.find` names its `tenantId`, because "which tenant" is part
of what an anonymous caller is asking; `orders.place` and `orders.find` name
none, because the caller's own identity establishes it, and a required field
the handlers ignore would be a lie in the contract.

**The contract says nothing about _who_ the caller is.** No principal type
appears anywhere in the contract package, so nothing about this deployment's
view of a caller — a user id, roles, an org tier — reaches a client, and
enriching it is never a contract change.

## What a caller is, and the one file that says so

Two files, both at the root of `src/`, and neither belongs to a slice:

```
src/auth.ts             httpAuth<Identity>() — states the principal, mints HttpController/HttpRouter/HttpAuthenticator on it
src/authenticator.ts    bearerAuthenticator — the provider that resolves an Identity from the request's headers
```

`auth.ts` is where `Identity` is stated, once, and the three pieces the slices
and the root import come back fixed to it:

```ts
import {
  httpAuth,
  type HttpAuthenticatorOf,
  type HttpControllerOf,
  type HttpRouterOf,
} from "@btravstack/http";

export type Identity = {
  readonly tenantId: string;
  readonly userId: string;
};

const identity = httpAuth<Identity>();

export const HttpController: HttpControllerOf<Identity> =
  identity.HttpController;
export const HttpRouter: HttpRouterOf<Identity> = identity.HttpRouter;
export const HttpAuthenticator: HttpAuthenticatorOf<Identity> =
  identity.HttpAuthenticator;
```

Once per application rather than once per slice, because a handler's parameter
types are fixed **where the arrow is written**: the composition root cannot
re-type a `sync` callback that lives inside `slices/orders/`, so the identity
has to be in scope there. That is also what makes the authenticator and the
controllers unable to disagree — both come from this one call. The three
`…Of<Identity>` aliases are annotations rather than ceremony: a controller's
port expands to a type carrying the marker's phantom `unique symbol`, which
this file cannot name in its own declaration emit.

It is the **only** way a handler gets a readable principal. A marked fragment
reached through `@btravstack/http`'s own top-level `HttpController` types
`principal: never`, so every read of it is a compile error — the signal to use
the factory, not a fallback.

`authenticator.ts` is then an ordinary di provider, with no type argument left
to state:

```ts
export const bearerAuthenticator = HttpAuthenticator([], {
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const [tenantId, userId] = token.split(":");
    return tenantId === undefined ||
      tenantId === "" ||
      userId === undefined ||
      userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync({ tenantId, userId });
  },
});
```

`Bearer <tenantId>:<userId>` is a stand-in, not a recommendation — what matters
is the shape. `[]` because this one needs no service; a JWT verifier, a key set
or a user directory would be named there and injected the way any provider's
dependencies are, so swapping the stand-in for real verification changes
nothing else in the composition. See
[Protect a procedure](/how-to/protect-a-procedure) for the recipe in full.

## The slices: a controller and a module each

Each slice lives under `slices/<name>/` — a `controller.ts` implementing that
slice's fragment, and a `module.ts` exporting only that controller. Both are
one file deep, because both are backed by the same three-package vertical:
use cases in [`order-application`](/examples/order-application), and the
entities and Prisma adapters behind it.

```
src/slices/orders/controller.ts       HttpController("OrdersController", contract.orders)([PlaceOrder, FindOrder, Logger], { sync })
src/slices/orders/module.ts           OrdersSlice — imports the vertical, provides the controller, exports only it
src/slices/customers/controller.ts    HttpController("CustomersController", contract.customers)([FindCustomer], { sync })
src/slices/customers/module.ts        CustomersSlice — same shape as OrdersSlice
```

`slices/orders/controller.ts` is the transport boundary and the only place in
this slice where a domain error becomes something else — `slices/customers/controller.ts`
below does the same for its own slice:

```ts
import { HttpController } from "../../auth.js";

export const ordersController = HttpController(
  "OrdersController",
  contract.orders,
)([PlaceOrder, FindOrder, Logger], {
  sync: (place, find, logger) => ({
    place: ({ errors, context }, input) => {
      logger.info("order placement requested", {
        userId: context.principal.userId,
      });
      return place
        .execute(context.principal.tenantId, input.id, input.quantity)
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
              errors.CONFLICT({
                message: error.message,
                data: { id: error.id },
              }),
            ),
        );
    },
    find: ({ errors, context }, input) =>
      find
        .execute(context.principal.tenantId, input.id)
        .map(view)
        .mapErrCases((matcher) =>
          matcher.with(P.tag("OrderNotFound"), (error) =>
            errors.NOT_FOUND({
              message: error.message,
              data: { id: error.id },
            }),
          ),
        ),
  }),
});
```

Each leaf is the `.result()` handler `@unthrown/orpc` gives that procedure's
implementer, typed by the contract at the call — the input is the fragment's
parsed input, `errors` its declared error map, and a typo'd or missing
procedure is a compile error **inside the controller**, not at the root. In
it, `Ok` is the output, an `Err` holding an `ORPCError` is **returned** (so
oRPC marks it inferable and the client gets it typed), and a `Defect`
rethrows its cause onto oRPC's own defect path, where it collapses to
`INTERNAL_SERVER_ERROR`.

The `mapErrCases` in between is the triage. Every case of the use case's
error type is named — this repository bans `P._`, and the matcher has no
`.otherwise()` — so a new domain error is a compile error here, at the one
place that has to decide what a client sees. A `Defect` is never named: it
was never modeled, and collapsing it to a 500 is the correct treatment rather
than a fallback.

The tenant comes off `context.principal` — the value `bearerAuthenticator`
resolved from this request's headers — and it is the only thing on oRPC's
context channel. `HttpController` is `auth.ts`'s, which is why `principal` has
a readable type here at all with no annotation at this call site. The starter
knows nothing about tenancy either way: it resolved a principal this
application defined, and what the fields on it mean is the application's
business. Who placed an order is a transport-boundary fact, so it is logged
here, on the request's own trace id, rather than pushed through a use case
that has no business with it.

`slices/customers/controller.ts` is the same shape over one procedure, built
from `FindCustomer` and mapping `CustomerNotFound` to the fragment's own
`NOT_FOUND`. Its fragment is **unmarked**, so its context has no `principal`
at all — reading one there is a compile error — and it takes its tenant from
`input.tenantId` instead. The contrast is the lesson: where a caller's identity
establishes the tenant, the input has nothing to say about it. It has its own `view` too, because its use case answers with the
branded `Customer` entity and `CustomerView` is the wire's shape — a slice is
defined by owning its fragment, its controller and its triage, not by owning a
private adapter. The throwaway in-memory directory this replaced declared its
port over `CustomerView` itself, which pointed the dependency arrow outwards.

## The router: composed from controllers, keyed by the contract

`module.ts`'s `orderRouter` is `HttpRouter(contract)`'s **keyed** form —
a record of controllers, one per top-level contract key, instead of one
`sync`:

```ts
import { HttpRouter } from "./auth.js";

export const orderRouter = HttpRouter(contract)({
  orders: ordersController,
  customers: customersController,
});
```

`HttpRouter` is `auth.ts`'s here too: the marker on `contract.orders` rides
through the keyed form, so the router carries the identity its controllers were
minted with, and the root below checks the authenticator against it.

This form is exact: a slice missing from the record, a key the contract does
not declare, and a controller wired under the wrong key are all compile
errors at this call — see
[Split a router into controllers](/how-to/split-a-router-into-controllers) for
the recipe, and `packages/http/src/controller.test-d.ts` for the five gates
that pin these errors and the lift below. Because a fragment is itself a valid
contract, `ordersController` serves `contract.orders` alone unchanged: the
lifted root is
`HttpRouter(contract.orders)([ordersController.port], { sync: (implementation) => implementation })`
over `OrdersSlice`, so extracting a slice out of this modulith is a new
composition root and one fewer import, not a rewrite.

## The composition root, and the process

`module.ts` is a list of **slices**, plus what no slice owns:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  authenticator: bearerAuthenticator,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

The `authenticator` is here and nowhere else, because who a caller is is one
answer per process rather than a slice's question — and it is _required_ here
because the contract marks `orders`: `HttpRouter` gave the router provider a
dependency on the starter's `AuthenticatorPort`, so dropping the line is an
unmet need `start` refuses, and supplying one that resolves a different
principal is a compile error at this very call.

Each slice imports its own vertical — `OrderApplicationModule`, whose
repository is an unmet need, and `OrderPersistenceModule`, which provides it —
so the root names what the process serves rather than everything every slice
happens to depend on:

```ts
export const OrdersSlice = Module("OrdersSlice")({
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [ordersController],
  exports: [ordersController],
});
```

The customers slice imports `CustomerApplicationModule` and
`CustomerPersistenceModule` — a different vertical, so a different pair. The
boundary reaches all the way down to the adapter: `FindCustomer` is not in the
orders graph, and `PlaceOrder` is not in the customers one. It is also what
lets the two workers, which have nothing to do with customers, import the
orders vertical alone.

Where the slices do meet is one level below: both persistence modules import
the same internal `DatabaseModule`, which owns the connection and is the only
module that exports `OrderDatabase`. That is a diamond, not duplication: di
flattens the module tree into a `Set` keyed by provider **reference**, so the
graph builds one database. `exports` takes the provider
rather than `ordersController.port` — `HttpController` minted that port, so
there is no class to spell back off it.

`HttpModule` imports the starter (`http()` — `HttpRuntime`, `HttpConfig` bound
from `PORT` / `HOST`, the router mounted under `/rpc`, needing the router the
root provides), provides `orderRouter` and exports `HttpRuntime`, and returns
exactly the module `Module("OrderApi")({...})` would have.
[`observability()`](/reference/observability) brings the `Logger` the
interactors and the request scope write to — bound from `LOG_LEVEL`, one JSON
object per line on stdout, every line carrying the unit's trace id — and
`Logger` is exported for the request scope below. It is a **constant**:
configuration is read inside the graph from the `Env` port the kernel provides,
so nothing is passed in from `main.ts`, and a spec boots this very module with
`env: { PORT: "0", HOST: "127.0.0.1" }`.

`main.ts` is one statement:

```ts
await runMain(OrderApi, {
  unit: RequestModule,
  onEvent: kernelEvents(createLogger(jsonSink())),
});
```

The process reads `PORT` (default `3000`), `HOST` (default `0.0.0.0`),
`LOG_LEVEL` (default `info`) and `PROBE_PORT` (default `9000`) — inside the
graph — and a malformed one is a `startFailed` event and exit `78`.
`kernelEvents` puts the kernel's nine lifecycle events in the same stream and
the same shape as the application's own lines, instead of the default JSON on
stderr; the logger there is built by hand because `building` is emitted while
the graph still is, so a sink taken out of the context it is watching would
have nothing to write the two events that matter most with. See
[Log and correlate](/how-to/log-and-correlate).

## A request scope over the application scope

The application scope is opened once, by the kernel, and holds the database;
opening another per request would give every request its own empty in-memory
database. So `request-scope.ts` declares what lives for one request, and the
kernel forks it:

```ts
export class RequestSpan extends Port("RequestSpan")<{
  readonly finish: () => void;
}> {}

export const RequestModule = Module("Request")({
  provides: [
    Provider(RequestSpan)([Logger], {
      sync: (logger) => {
        const startedAt = Date.now();
        return {
          finish: () =>
            logger.info("request finished", {
              durationMs: Date.now() - startedAt,
            }),
        };
      },
      onStop: (span) => span.finish(),
    }),
  ],
  exports: [RequestSpan],
});
```

Passed as `StartOptions.unit`, it is built as the request opens and torn down
as it closes, reading `Logger` out of the parent without rebuilding it.
`onStop` runs while the unit is still open, which is what gives its line the
request's own trace id — and no handler code manages the fork. See
[Open a per-request scope](/how-to/open-a-per-request-scope).

## The spec: booting the real module on `PORT=0`

`test-fixtures.ts` starts from `@btravstack/testing`'s `bootFixture` and
wraps it in `serve`, where every spec starts, real composition root included:

```ts
export const it = test.extend<ApiFixtures>({
  boot: bootFixture({
    env: { PORT: "0", HOST: "127.0.0.1", LOG_LEVEL: "fatal" },
  }),

  serve: async ({ boot }, use) => {
    await use((module, options) =>
      boot(module, { unit: RequestModule, ...options }),
    );
  },
  // …
});
```

`boot` brings a test's defaults (`signals: false`, `probes: false`,
`preDrainDelayMs: 0`, a silent sink) and stops every app it started when the
test ends; `serve` adds the per-request `RequestModule`, and `LOG_LEVEL:
"fatal"` keeps the real root — whose sink is the production `jsonSink()` on
stdout — out of the runner's own output. The port comes back
from `Serving.info` through `app.runtimeInfo()` — the kernel's own channel
for it — and the client is built from the contract alone. What it carries on
top of that is one header: `clientFor` sends
`authorization: Bearer <tenant>:u-1`, since the `orders` fragment is marked and
an anonymous call to it never reaches a use case, while `clientWith` states the
token verbatim — or omits it — for the specs about the refusal itself. The
`tenant` is a UUID per test, which is what lets every spec share one database. Where a spec needs
the lines the running graph wrote, the seam is
`observability({ sink })`: the `recording` fixture composes the root's shape
with a sink that keeps every `Line`, so an assertion reads `line.unit.traceId`
as a field rather than parsing a prefix out of a string. The suite then pins what matters: a `DuplicateOrder` arrives as an
`Err` holding an inferable `CONFLICT`, a value the client matches by code, not
a thrown 500:

```ts
expect(conflict).toBeErrWith(
  expect.objectContaining({
    constructor: ORPCError,
    code: "CONFLICT",
    data: { id: "o-1" },
    inferable: true,
  }),
);
```

An unmodeled repository failure collapses to `INTERNAL_SERVER_ERROR` without
leaking its message, and the process keeps serving afterwards; each call runs
in its own unit with its own trace id (two calls, four log lines, two distinct
`line.unit.traceId`s, none written outside a unit); a call held open in the
repository finishes during a drain
and is counted `completed`, one still hung at a zero deadline is counted
`abandoned`; `/livez` and `/readyz` answer while serving, and readiness goes
false before liveness during the drain; and the `customers` slice answers over
the same client and the same running root — a `CustomerView` on the way out of
a stub-backed root, a typed `NOT_FOUND` out of the real one — proving the keyed
router actually mounted both controllers rather than one.

## Five gates, pinned at compile time

`needs-gate.test-d.ts` is type-checked, never executed. It pins the two
directions of `start`'s own gate and di's, side by side:

```ts
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);
```

`RuntimelessApi` is the same list of slices without `http(...)`: `start`'s phantom
rest tuple becomes a required argument naming the absence, and the call fails
on arity. It provides `bearerAuthenticator` even so, deliberately: the contract
marks `orders`, so a graph carrying the router without an authenticator has an
unmet need too, and an arm that could fail either way pins neither gate.

```ts
const RouterlessApi = Module("RouterlessApi")({
  imports: [OrdersSlice, CustomersSlice, observability(), http()],
  exports: [HttpRuntime, Logger],
});

// @ts-expect-error — the composition needs the router port and nothing provides it.
const _missingRouter = start(RouterlessApi, options);
```

This one is **di's** gate, not the kernel's: `http()`'s runtime provider
depends on the starter's own router port through di, so a composition that
imports the starter without providing the router carries an unmet need, and
`start` — which accepts only `Scope | Env` outstanding — refuses the module.
There is no `UNSATISFIED RUNTIME NEEDS` arm here, because the shipped runtime
declares no needs.

```ts
// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });
```

The `unit` half, in both directions: `start(OrderApi, { unit: RequestModule })`
is an ordinary call because `OrderApi` exports the `Logger` the fork reads,
and `UnloggedApi` — runtime and router present, `observability()` imported so
the port exists in the graph, `Logger` simply not exported — is
rejected by the unit arm alone.

The last two are the authenticator's, and they are different gates on purpose:

```ts
const UnauthenticatedApi = HttpModule("UnauthenticatedApi")({
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});

// @ts-expect-error — the composition needs the authenticator port and nothing provides it.
const _missingAuthenticator = start(UnauthenticatedApi, options);
```

That is **di's** gate again, at `start` and not at `HttpModule(...)` — which is
why the module above builds without complaint. The other one cannot be di's at
all: `AuthenticatorPort`'s service type is erased to `unknown`, so any
authenticator discharges the need. `HttpModule` compares the router's identity
against the authenticator's itself, at the option:

```ts
const wrongAuthenticator = HttpAuthenticator<{ readonly sub: string }>()([], {
  sync: () => () => OkAsync({ sub: "s-1" }),
});

const _mismatchedApi = HttpModule("MismatchedApi")({
  router: orderRouter,
  // @ts-expect-error — the authenticator resolves `{ sub }`, not the router's Identity.
  authenticator: wrongAuthenticator,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

The directive sits on the option rather than on a `start` below it, because
that is where the failure is. The contract declares no principal to compare
against; `auth.ts` is what declares one.

## Where to go next

- The same `DuplicateOrder`, orchestrated: [Order Temporal worker](/examples/order-temporal-worker).
- The marker, `auth.ts` and the authenticator as a recipe: [Protect a procedure](/how-to/protect-a-procedure).
- The package behind the transport: [`@btravstack/http`](/reference/http).
- Why the kernel appears in none of this: [The kernel maps nothing](/explanation/the-kernel-maps-nothing).
