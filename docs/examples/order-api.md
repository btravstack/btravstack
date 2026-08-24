---
title: Order API example
description: The HTTP deployment — two slices, orders and customers, one marked with a named security scheme and one public, each its own contract fragment, HttpController and full vertical down to Prisma, an auth.ts declaring two schemes and a scope through defineHttp, composed by the keyed HttpRouter form into one HttpModule root, RequestModule forked per request, a main.ts that is one runMain call with the kernel's events on the application's own logger, and the three compile-time gates pinned by needs-gate.test-d.ts.
---

<!-- doctest: prelude
import { runMain, Logger, Meter, Tracer } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { HttpModule } from "@btravstack/http";
import { OkAsync, P } from "unthrown";
import { createLogger, jsonSink, kernelEvents, observability } from "@btravstack/observability";
import { UnitSpanModule, otel } from "@btravstack/observability/otel";
import type { Order } from "@btravstack/example-order-domain";
import { FindOrder, OrderApplicationModule, PlaceOrder } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { api } from "../../auth.js";
import { customersController } from "../../slices/customers/controller.js";
import { CustomersSlice } from "../../slices/customers/module.js";
declare const view: (order: Order) => { id: string; quantity: number };
-->

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

const orderView = z.object({ id: z.uuidv7(), quantity: z.number() });
export type OrderView = z.infer<typeof orderView>;

const orderRef = z.object({ id: z.uuidv7() });
export type OrderRef = z.infer<typeof orderRef>;

// The one ref whose `id` is a bare string. It names the id **as received**,
// which is exactly the value that is not a UUIDv7 — validating it against
// `z.uuidv7()` would reject the only payload `BAD_REQUEST` ever carries.
const malformedRef = z.object({ id: z.string() });

// The unmarked fragment names its tenant on the input; the marked one does not,
// because a caller's identity establishes it there.
const tenanted = z.object({ tenantId: z.uuidv7() });

const customerView = z.object({ id: z.uuidv7(), name: z.string() });
export type CustomerView = z.infer<typeof customerView>;

// Same shape as `orderRef`, deliberately not the same schema: reusing it would
// type a customer id as "which order it was about".
const customerRef = z.object({ id: z.uuidv7() });
export type CustomerRef = z.infer<typeof customerRef>;

// The group default: every procedure beneath needs the `user` scheme.
const ordersContract = authenticated({ user: [] })({
  place: oc
    .input(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .output(orderView)
    .errors({
      INVALID_QUANTITY: { data: orderRef },
      BAD_REQUEST: { data: malformedRef },
      CONFLICT: { data: orderRef },
    }),
  find: oc
    .input(orderRef)
    .output(orderView)
    .errors({ NOT_FOUND: { data: orderRef } }),

  // Overrides the group default for itself: a service token may export too,
  // and a user token needs the scope.
  export: authenticated(
    { user: ["orders:export"] },
    { service: [] },
  )(oc.output(z.object({ csv: z.string() }))),
});

const customersContract = {
  find: oc
    .input(tenanted.extend({ id: z.uuidv7() }))
    .output(customerView)
    .errors({ NOT_FOUND: { data: customerRef } }),
};

export const contract = {
  orders: ordersContract,
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

[`authenticated({ user: [] })`](/reference/contract) on `orders` is a
type-level fact about
the fragment, so a client reads which half of this API needs credentials — and
under which scheme — off
the contract itself, and a server that serves the marked half without an
authenticator for that scheme does not compile. `orders.export` overrides that
group default for itself, which is how one contract exercises a per-procedure
override, a **scope** and a **second scheme** all at once: a `user` token
granting `orders:export`, **or** a `service` key needing no scope. It is also
why the two fragments' inputs
differ: `customers.find` names its `tenantId`, because "which tenant" is part
of what an anonymous caller is asking; `orders.place` and `orders.find` name
none, because the caller's own identity establishes it, and a required field
the handlers ignore would be a lie in the contract.

**The contract says nothing about _who_ the caller is.** No principal type
appears anywhere in the contract package, so nothing about this deployment's
view of a caller — a user id, roles, an org tier — reaches a client, and
enriching it is never a contract change.

## What a caller is, and the one file that says so

One file, at the root of `src/`, belonging to no slice:

```
src/auth.ts             the two schemes, and the one defineHttp call that declares them
```

`auth.ts` is where each scheme's identity is stated and its authenticator
written, and where the one `defineHttp` call the application makes lives:

<!-- doctest: isolate
import { TenantId } from "@btravstack/example-order-domain";
import { HttpAuthenticator, Unauthenticated, defineHttp, granted } from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";
-->

```ts
import { TenantId } from "@btravstack/example-order-domain";
import {
  HttpAuthenticator,
  Unauthenticated,
  defineHttp,
  granted,
} from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";

/** What this deployment knows about a caller under the `user` scheme. */
export type Identity = {
  readonly tenantId: TenantId;
  readonly userId: string;
};

/** What the `service` scheme resolves to: a machine caller, no tenant. */
export type ServiceIdentity = { readonly appId: string };

export const userAuth = HttpAuthenticator<Identity, "orders:export">()({
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const [tenantId, userId, ...rest] = token.split(":");
    // Rejoined rather than taken as one field: a scope name contains the
    // delimiter itself, so `orders:export` cannot survive a plain third field.
    const claimed = rest.join(":");
    return tenantId === undefined ||
      tenantId === "" ||
      userId === undefined ||
      userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync(
          granted(
            { tenantId: TenantId(tenantId), userId },
            claimed
              .split(",")
              .filter(
                (scope): scope is "orders:export" => scope === "orders:export",
              ),
          ),
        );
  },
});

/** The second scheme: an API key, no scopes — what a reporting job presents. */
export const serviceAuth = HttpAuthenticator<ServiceIdentity>()({
  sync: () => (headers) => {
    const key = headers["x-api-key"];
    return typeof key === "string" && key !== ""
      ? OkAsync({ appId: key })
      : ErrAsync(new Unauthenticated());
  },
});

export const api = defineHttp({
  authenticators: { user: userAuth, service: serviceAuth },
});
```

Once per application rather than once per slice, because a handler's parameter
types are fixed **where the arrow is written**: the composition root cannot
re-type a `sync` callback that lives inside `slices/orders/`, so the registry
has to be in scope there. Declaring a scheme and implementing it are the
**same act**, which is why there is no registry to keep in step with the
contract and no authenticator for the root to list.

::: warning Held whole — never destructured
`const { HttpController } = defineHttp(...)` is **TS2527**: each binding of a
destructured member expands to a type mentioning the marker's inaccessible
`unique symbol`, which this file could not emit. Held whole, the inferred type
collapses to `Http<A>`, which is nameable — which is why this file, unlike the
one it replaced, carries **no type annotation at all**.
:::

It is the **only** way a handler gets a readable principal. A marked fragment
reached through any other `defineHttp` call types
`principal: never`, so every read of it is a compile error — the signal to use
the factory, not a fallback.

`Bearer <tenantId>:<userId>:<scopes>` is a stand-in, not a recommendation —
what matters is the shape. This is also where a header becomes a **tenant**:
`TenantId` is
the domain's branded string, so the identity carries the brand from here and no
handler on this path casts anything. The constructor is a cast rather than a
parse — a brand is a compile-time fiction, and what it buys is that
`repository.find(tenantId, id)` can no longer be called with its two arguments
the other way round. The scope **vocabulary** is declared at the call
(`HttpAuthenticator<Identity, "orders:export">()`), so the granted list is
checked against it here rather than compared as loose strings at the endpoint.
Neither authenticator needs a service; a JWT verifier, a key set
or a user directory would be named in a `deps` record and injected the way any
provider's
dependencies are, and that need would travel with the authenticator into the
graph — so a root satisfying none is refused at the `HttpModule(...)` call. See
[Protect a procedure](/how-to/protect-a-procedure) for the recipe in full.

## The slices: a controller and a module each

Each slice lives under `slices/<name>/` — a `controller.ts` implementing that
slice's fragment, and a `module.ts` exporting only that controller. Both are
one file deep, because both are backed by the same three-package vertical:
use cases in [`order-application`](/examples/order-application), and the
entities and Prisma adapters behind it.

```
src/slices/orders/controller.ts       api.HttpController("OrdersController", contract.orders)({ place: PlaceOrder, find: FindOrder, logger: Logger }, { sync })
src/slices/orders/module.ts           OrdersSlice — imports the vertical, provides the controller, exports only it
src/slices/customers/controller.ts    api.HttpController("CustomersController", contract.customers)({ find: FindCustomer }, { sync })
src/slices/customers/module.ts        CustomersSlice — same shape as OrdersSlice
```

`slices/orders/controller.ts` is the transport boundary and the only place in
this slice where a domain error becomes something else — `slices/customers/controller.ts`
below does the same for its own slice:

```ts
import { api } from "../../auth.js";

export const ordersController = api.HttpController(
  "OrdersController",
  contract.orders,
)(
  { place: PlaceOrder, find: FindOrder, logger: Logger },
  {
    sync: ({ place, find, logger }) => ({
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
              // A malformed id is the caller's mistake, so 400 — not the
              // 409 a duplicate gets.
              .with(P.tag("InvalidOrderId"), (error) =>
                errors.BAD_REQUEST({
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
      // Two schemes, so the principal is a discriminated union — and the
      // switch is exhaustive or the build fails. The body names the arm that
      // produced it, so a spec can pin which scheme served the call.
      export: ({ context }) => {
        switch (context.principal.scheme) {
          case "user":
            logger.info("order export requested", {
              userId: context.principal.identity.userId,
            });
            return OkAsync({
              csv: `user,${context.principal.identity.userId}`,
            });
          case "service":
            logger.info("order export requested", {
              appId: context.principal.identity.appId,
            });
            return OkAsync({
              csv: `service,${context.principal.identity.appId}`,
            });
        }
      },
    }),
  },
);
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

The tenant comes off `context.principal` — the value the `user` scheme's
authenticator
resolved from this request's headers — and it is the only thing on oRPC's
context channel. `HttpController` comes off `auth.ts`'s `api`, which is why
`principal` has
a readable type here at all with no annotation at this call site. `place` and
`find` name **one** scheme, so they read the identity bare — byte-for-byte what
this file held before named schemes existed; `export` names two, so its
principal is tagged and the compiler checks that every scheme the contract
named is answered for. That contrast is the whole design: the common case pays
nothing. The starter
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
establishes the tenant, the input has nothing to say about it. That is the one
`TenantId(input.tenantId)` in the application: the fragment validated the field
as a UUIDv7, and the brand is claimed once, where the wire's `string` becomes
the application's vocabulary. It has its own `view` too, because its use case answers with the
branded `Customer` entity and `CustomerView` is the wire's shape — a slice is
defined by owning its fragment, its controller and its triage, not by owning a
private adapter. The throwaway in-memory directory this replaced declared its
port over `CustomerView` itself, which pointed the dependency arrow outwards.

## The router: composed from controllers, keyed by the contract

`module.ts`'s `orderRouter` is `api.HttpRouter(contract)`'s **keyed** form —
a record of controllers, one per top-level contract key, instead of one
`sync`:

```ts
import { api } from "./auth.js";

export const orderRouter = api.HttpRouter(contract)({
  orders: ordersController,
  customers: customersController,
});
```

`HttpRouter` comes off the same `api` as the controllers: the marks on
`contract.orders` ride
through the keyed form, so the router declares **one dependency per scheme the
contract names** — `HttpAuthenticator:user` and `HttpAuthenticator:service` —
and carries the providers that discharge them, from that same call.

This form is exact: a slice missing from the record, a key the contract does
not declare, and a controller wired under the wrong key are all compile
errors at this call — see
[Split a router into controllers](/how-to/split-a-router-into-controllers) for
the recipe, and `packages/http/src/controller.test-d.ts` for the five gates
that pin these errors and the lift below. Because a fragment is itself a valid
contract, `ordersController` serves `contract.orders` alone unchanged: the
lifted root is
`api.HttpRouter(contract.orders)({ implementation: ordersController.port }, { sync: ({ implementation }) => implementation })`
over `OrdersSlice`, so extracting a slice out of this modulith is a new
composition root and one fewer import, not a rewrite.

## The composition root, and the process

`module.ts` is a list of **slices**, plus what no slice owns:

<!-- doctest: defer -->

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice, observability(), otel()],
  // `RequestModule` reads all three out of the application scope.
  exports: [Logger, Tracer, Meter],
});
```

The two authenticators are **not** listed, and that is the point: who a caller
is is one answer per process rather than a slice's question, so they were
declared once in `auth.ts`, and they ride the router — which is what needs
them. `HttpModule` puts them in `provides` itself, so a scheme cannot be
forgotten here and cannot be wired to the wrong router. What is still checked
is di's own gate: a scheme the contract names with no authenticator behind it
leaves `HttpAuthenticator:<scheme>` in the root's needs, which `start` refuses,
naming the port.

Each slice imports its own vertical — `OrderApplicationModule`, whose
repository is an unmet need, and `OrderPersistenceModule`, which provides it —
so the root names what the process serves rather than everything every slice
happens to depend on:

```ts
export const OrdersSlice = Module("OrdersSlice")({
  // The controller writes a line itself, so `Logger` is this slice's own
  // provider's need. The environment its persistence reads `DATABASE_URL` from
  // is not: that one is `DatabaseModule`'s, declared there and inherited
  // through the imports below.
  needs: [Logger],
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

<!-- doctest: defer -->

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
  needs: [Logger, Meter],
  imports: [UnitSpanModule],
  provides: [
    Provider(RequestSpan)(
      { logger: Logger, meter: Meter },
      {
        sync: ({ logger, meter }) => {
          const startedAt = Date.now();
          const duration = meter.createHistogram(
            "btravstack.request.duration",
            {
              unit: "ms",
            },
          );
          return {
            finish: () => {
              const durationMs = Date.now() - startedAt;
              duration.record(durationMs);
              logger.info("request finished", { durationMs });
            },
          };
        },
        onStop: (span) => span.finish(),
      },
    ),
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

<!-- doctest: skip — an excerpt of src/test-fixtures.ts, which the gate compiles and runs -->

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

<!-- doctest: skip — an assertion excerpt of src/api.spec.ts, which the gate runs -->

```ts
expect(conflict).toBeErrWith(
  expect.objectContaining({
    constructor: ORPCError,
    code: "CONFLICT",
    data: { id: "0199a1e0-0000-7000-8000-000000000001" },
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

## Three gates, pinned at compile time

`needs-gate.test-d.ts` is type-checked, never executed. It pins the two
directions of `start`'s own gate and di's, side by side:

<!-- doctest: skip — quotes src/needs-gate.test-d.ts, the real gate for the NO RUNTIME arm -->

```ts
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);
```

`RuntimelessApi` is the same list of slices without `http(...)`: `start`'s
phantom marker becomes the sentence
`"NO RUNTIME — the module exports no port declared over RuntimePort"`, and the
module argument fails to match its parameter type — the sentence is the error's
last line. It provides `orderRouter` **and `...orderRouter.authenticators`**
even so, deliberately: the contract
marks `orders`, so a graph carrying the router without them has an
unmet need too, and an arm that could fail either way pins neither gate. That
spread is exactly what `HttpModule` does for a root that uses the sugar.

<!-- doctest: skip — quotes src/needs-gate.test-d.ts, the real gate for the missing-router arm -->

```ts
const RouterlessApi = Module("RouterlessApi")({
  imports: [OrdersSlice, CustomersSlice, observability(), http()],
  exports: [HttpRuntime, Logger],
});

// @ts-expect-error — the composition needs the router port and nothing provides it.
const _missingRouter = start(RouterlessApi, options);
```

This one is the **`Needs` channel**, not the kernel's marker and not di's
declaration gate either: the port is owed by `http()`, an **import**, and an
import's needs travel without the importer re-declaring them. `start` — whose
`module` parameter accepts only `Scope | Env` outstanding — is what refuses it,
and the diagnostic names the port:
`Type 'HttpRouterPort' is not assignable to type 'Env | Scope'`, down to
`Type '"HttpRouter"' is not assignable to type '"@di/Scope"'`. It is **not** di's
`UNSATISFIED DEPENDENCIES` dependency gate, which guards `Module.build` and
`Module.scoped`; conflating the two is easy and the distinction is the point of
having both pinned here. There is no `UNSATISFIED RUNTIME PORTS` arm, because
the shipped runtime resolves nothing.

<!-- doctest: skip — quotes src/needs-gate.test-d.ts, the real gate for the UNSATISFIED UNIT NEEDS arm -->

```ts
// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });
```

The `unit` half, in both directions: `start(OrderApi, { unit: RequestModule })`
is an ordinary call because `OrderApi` exports the `Logger` the fork reads,
and `UnloggedApi` — runtime and router present, `observability()` imported so
the port exists in the graph, `Logger` simply not exported — is
rejected by the unit arm alone.

**What is no longer here, and why.** This file used to carry two more arms
about the authenticator — a root that forgot to pass one, and a root that
passed one resolving the wrong identity. Neither is reachable any more. The
authenticators come from the same `defineHttp` call that types the handlers and
ride the router into `provides`, so there is nothing to forget and no pair to
compare — a scheme with nobody behind it is di's own unmet need on
`HttpAuthenticator:<scheme>`, which the router-port arm above already pins the
shape of.

## Where to go next

- The same `DuplicateOrder`, orchestrated: [Order Temporal worker](/examples/order-temporal-worker).
- The marker, `auth.ts`, scopes and the 401/403 split as a recipe: [Protect a procedure](/how-to/protect-a-procedure).
- The package behind the transport: [`@btravstack/http`](/reference/http).
- Why the kernel appears in none of this: [The kernel maps nothing](/explanation/the-kernel-maps-nothing).
