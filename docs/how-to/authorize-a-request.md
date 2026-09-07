---
title: Authorize a request
description: Three layers — a scope in the contract, a tenant in the unit, a policy in the handler — each checked by the layer that can check it before the process runs, with PostgreSQL row-level security as the floor underneath.
---

<!-- doctest: prelude
import { Logger } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { contract } from "@btravstack/example-order-api-contract";
import {
  FindOrder,
  ListOrders,
  OrderApplicationModule,
  PlaceOrder,
  Tenant,
} from "@btravstack/example-order-application";
import { OrderTenantPersistence } from "@btravstack/example-order-infrastructure";
import { P } from "unthrown";
import { api, auth } from "../../auth.js";
import { RequestModule } from "../../request-scope.js";
import { exportable, renderCsv } from "../../slices/orders/authorize.js";
-->

# Authorize a request

> **How-to.** Three questions, three layers, each answered where it can be:
> a **scope** in the contract, a **tenant** in the unit, a **policy** in the
> handler. Row-level security underneath is not a fourth layer — it is the
> floor the three stand on. For the marker, see
> [Protect a procedure](/how-to/protect-a-procedure); for the fork,
> [Open a per-request scope](/how-to/open-a-per-request-scope); for the worked
> deployment, [Order API (HTTP)](/examples/order-api).

Each layer is checked by whoever can check it **before the process runs**, and
what is left over falls to the next one. A scope is a property of the
credential, so the contract declares it and the starter answers it before a
handler is entered. A tenant is a property of the caller, so the unit scope is
built over it and a handler has no tenant to thread. What remains is a decision
about one resource that had to be fetched first — and only the handler holds
that, so it is written by hand, once, as a plain function.

|               | The question                                   | Where it is checked                                              | What a mistake looks like                                                                                       |
| ------------- | ---------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **scope**     | may this KIND of caller reach the procedure?   | the contract, by the starter, before dispatch                    | a scope no scheme can grant is refused at `OrpcRouter`; a caller lacking one gets a bare `403`                  |
| **tenant**    | which rows exist for this caller at all?       | the unit fork, as the graph for this request is built            | a tenant-bound port on an unmarked leaf does not compile; a graph that never said which tenant does not compile |
| **policy**    | may THIS caller do THIS to THIS resource?      | the handler, the only layer that has the resource                | forgetting the rule is a compile error — the operation it protects does not take a plain resource               |
| **the floor** | did this statement say which tenant it is for? | PostgreSQL, per statement, against the `tenant_isolation` policy | an unpinned read matches no row; an unpinned write is refused with `42501`                                      |

`orders.export` in [`examples/order-api`](/examples/order-api) is where all
four meet, and each fence below is drawn from one of the places it is decided,
trimmed to this leaf — so a binding such as `exportProcedure` is this page's,
where the example spells the same procedure inside `contract.orders`.

## 1. Scope, in the contract

Declare which schemes may reach the procedure, and which scopes each must
grant, in the artifact both sides read:

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const orderRef = z.object({ id: z.uuidv7().brand("OrderId") });

// A `user` token granting `orders:export`, OR a `service` key with no scopes
// at all. `FORBIDDEN` is declared, which is what makes the rule's own refusal
// in step 3 a value rather than a defect.
export const exportProcedure = authenticated(
  { user: ["orders:export"] },
  { service: [] },
)(
  oc
    .input(z.object({ id: z.uuidv7() }))
    .output(z.object({ csv: z.string() }))
    .errors({
      NOT_FOUND: { data: orderRef },
      FORBIDDEN: { data: orderRef.extend({ reason: z.string() }) },
    }),
);
```

A scope belongs here because it is answerable **before dispatch**: it is a
property of the credential, so nothing has to be fetched to decide it. The
starter compares the granted scopes against the requirement and refuses an
under-scoped caller with a `403` the handler is never entered for. The
vocabulary is compile-gated against the scheme that grants it —
`jwtAuthenticator`'s `scopes: ["orders:export"]` — so a requirement naming a
scope no scheme can grant is refused at `api.OrpcRouter(...)` rather than
refusing every caller in production.

The whole of this layer, including the schemes behind it, is
[Protect a procedure](/how-to/protect-a-procedure).

## 2. Tenant, in the unit

Provide `Tenant` from the principal, in the module the runtime forks for that
scheme, and let the repositories and use cases be built over it:

```ts
import { auth } from "./auth.js";

export const UserModule = Module("User")({
  needs: [auth.principals.user],
  imports: [RequestModule, OrderTenantPersistence, OrderApplicationModule],
  provides: [
    Provider(Tenant)({
      inject: { principal: auth.principals.user },
      sync: ({ principal }) => principal.tenantId,
    }),
  ],
  exports: [RequestModule, Tenant, PlaceOrder, FindOrder, ListOrders],
});

export const ServiceModule = Module("Service")({
  needs: [auth.principals.service],
  imports: [RequestModule, OrderTenantPersistence, OrderApplicationModule],
  provides: [
    Provider(Tenant)({
      inject: { principal: auth.principals.service },
      sync: ({ principal }) => principal.tenantId,
    }),
  ],
  exports: [RequestModule, FindOrder],
});
```

**Both kinds name a tenant, and neither takes it from the request.** A user's
comes off the token's own claim; a service's comes off the API key, which is
cut **for** a tenant — `ServiceIdentity` is `{ appId, tenantId }`, stated on
the key entry, so a second key cannot inherit the first's rows by saying
nothing. A machine has no login to take one from, and the credential is the
only thing left that can say.

`OrderTenantPersistence` reads the one client out of the application scope and
provides the repository over a tenant-bound `Db`, so the use cases a handler
reaches were built for that tenant before the handler ran. `find(id)` has no
tenant parameter to get wrong — the argument the layer would be forgotten in
does not exist.

**A leaf sees the intersection of what its kinds export.** `export` accepts
both schemes, so it can read `context.unit.find` and neither `place` nor
`list`: `ServiceModule` exports only the first, and a read of the others is
TypeScript's own `Property 'place' does not exist`. On an unmarked leaf the
record is `anonymous`'s, which exports nothing tenant-bound at all — so a
tenant-bound port on a public procedure is a compile error rather than a leak.
A root that composes the vertical without ever saying which tenant it is for is
di's `UNSATISFIED DEPENDENCIES — nothing provides: Tenant`.

The fork itself, the kinds, and the gate on the kinds a root binds are
[Open a per-request scope](/how-to/open-a-per-request-scope).

## 3. Policy, in the handler

Write the rule as a plain function from `(caller, resource)` to a `Result`, and
give the operation it protects a parameter type only that function can produce:

<!-- doctest: isolate
import type { Caller } from "../../auth.js";
-->

```ts
import type { Order, OrderId } from "@btravstack/example-order-domain";
import { Err, Ok, TaggedError, type Result } from "unthrown";

import type { Caller } from "../../auth.js";

declare const AUTHORIZED: unique symbol;

/** An order the rule has admitted for export. Only `exportable` mints one. */
export type Authorized<T> = T & { readonly [AUTHORIZED]: true };

/** The refusal, in this application's own words rather than a status code. */
export class Forbidden extends TaggedError("Forbidden")<{
  readonly id: OrderId;
  readonly reason: string;
}> {
  override message = `order ${this.id} may not be exported: ${this.reason}`;
}

/** How many items an order may carry before exporting it stops being a user's operation. */
export const USER_EXPORT_CEILING = 1_000;

/** Layer 3: `(principal, resource) → decision`, decided where the resource is known. */
export const exportable = (
  caller: Caller,
  order: Order,
): Result<Authorized<Order>, Forbidden> => {
  switch (caller.scheme) {
    case "service":
      return Ok(order as Authorized<Order>);
    case "user":
      return order.quantity <= USER_EXPORT_CEILING
        ? Ok(order as Authorized<Order>)
        : Err(
            new Forbidden({
              id: order.id,
              reason: "bulk export is a service operation",
            }),
          );
  }
};

/** The operation the decision protects: there is no way to call it without one. */
export const renderCsv = (order: Authorized<Order>): string =>
  `id,quantity\n${order.id},${order.quantity}`;
```

The handler fetches through the unit — which is layer 2, so the row is already
this tenant's — decides, and folds the refusal into the code the contract
declared:

```ts
import { api } from "../../auth.js";
import { exportable, renderCsv } from "./authorize.js";

export const exportController = api.OrpcController(
  contract.orders,
  "export",
)({
  inject: { logger: Logger },
  unit: { find: FindOrder },
  sync:
    ({ logger }) =>
    ({ errors, context }, input) => {
      logger.info("order export requested", {
        id: input.id,
        scheme: context.principal.scheme,
      });
      return context.unit.find
        .execute(input.id)
        .flatMap((order) => exportable(context.principal, order).toAsync())
        .map((authorized) => ({ csv: renderCsv(authorized) }))
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            )
            .with(P.tag("Forbidden"), (error) =>
              errors.FORBIDDEN({
                message: error.message,
                data: { id: error.id, reason: error.reason },
              }),
            ),
        );
    },
});
```

A **piece is one contract key**, so the fence above is a controller over
`export` alone and nothing else — which is what makes it the handler and
nothing more. A piece composes into a router before anything serves it —
`api.OrpcRouter(contract.orders)([...])` with this piece in the array, or the
example's full one — and an array missing a leaf is refused as `UNCOVERED
CONTROLLERS`. In the example the same leaf sits in `ordersController` beside
`place`, `find` and `list`.

**Why a plain function and not a framework port.** The framework cannot invoke
a rule that runs **after** a fetch: the resource does not exist until the
handler asked for it, so there is no seam before the handler to hang a policy
on. And a registry does not make a **missing** rule visible — a handler that
never called it registers nothing and compiles. A **witness** does:
`renderCsv` takes an `Authorized<Order>`, so the operation the decision
protects cannot be reached without the decision.

**What the witness buys, exactly.** A **forgotten** rule is a compile error.
A caller determined to skip it can still write `order as Authorized<Order>`,
because the type is exported so a signature can carry it — but that is a lie in
one line, and one a reviewer greps for. `AUTHORIZED` itself is `declare`d and
never exported, so no other module can name the symbol and mint the witness by
construction.

**Why `Forbidden` is the application's own.** The kernel maps no outcome to a
transport, and the mapping is the handler's — the same exhaustive `mapErrCases`
that folds every domain error, with no wildcard, so a new refusal is a compile
error at the one place that decides what a client sees. A framework `Forbidden`
would have to be triaged in the same arm on all three transports; the stated
trigger for shipping one is that arm appearing three times, and it has not
fired.

**Ownership is the rule most applications write, on this exact shape.** "Is
this caller the order's owner?" is `(principal, resource) → decision` like any
other, and it goes in the same function. This example uses a quantity ceiling
instead because its domain records no owner — a worker places orders with
nobody behind them — not because ownership needs anything else.

**A policy engine is the rule's body, not a fourth layer.** A deployment that
keeps its rules in Cerbos, OPA or OpenFGA — editable without a release,
audited in one place, a relationship graph for "shared with" — calls it from
inside `exportable` and still mints the witness on the answer. The engine is
what makes a rule editable; the witness is what makes asking it unskippable.
Neither does the other's job, which is why the framework names the second and
leaves the first to the deployment.

## Underneath: the database refuses what the layers missed

[`@btravstack/prisma/rls`](/reference/prisma)'s `tenantScoped(tenant)` pins
every statement the unit issues — raw SQL included — to the tenant the fork was
seeded with, through a transaction-local `set_config`. The
`tenant_isolation` policy on the table, under `FORCE ROW LEVEL SECURITY`, is
what narrows the query. Omission fails **closed**: an unpinned read matches no
row rather than erroring, and an unpinned write is refused.

It is the floor, not a fourth layer, because it answers a different question —
not "may this caller", but "did anything at all say which tenant this statement
is for". It cannot express a scope or a ceiling, and it does not know a caller
exists. What it is for is the case the three layers above got wrong: a query
that escapes the unit-bound repository still matches nothing.

Two deployment facts decide whether any of it is real, and forgetting either
leaves row security that enforces nothing and looks fine: the policy must read
the **same** setting `tenantScoped` was given, and the application role must be
neither a superuser nor `BYPASSRLS`. Both, with the DDL and what each looks like
when it is missing, are on
[`@btravstack/prisma`](/reference/prisma#row-level-security-on-the-btravstack-prisma-rls-subpath).

## What is deliberately not here

- **An ambient tenant on the unit record.** `UnitRecord.tenantId` is left unset
  by every shipped runtime: a tenant read out of a store is a tenant a compiler
  cannot miss, where a typed dependency of the unit scope makes a forgotten one
  a compile error.
- **A framework `Policy` port, registry or `Forbidden`.** The framework cannot
  invoke a policy that runs after a fetch, and a registry does not make a
  missing one visible.
- **A per-unit pinned connection.** A unit does not close until the response is
  flushed, so a pinned connection would stay checked out while bytes go to the
  client; the batch form pins nothing across a response.
- **Policy generation for Prisma.** Prisma has no policy DDL, so the migration
  is hand-written. That is a reason to build a Drizzle starter one day, not a
  reason to change the model — nothing above is Prisma-specific.

## Testing it

Three levels, and each one is a different test:

- **The rule, pure.** `authorize.spec.ts` calls `exportable(caller, order)`
  directly — a service caller over the ceiling, a user at it, a user past it —
  and asserts the refusal names which order and why. No transport, no database.
- **The procedure, over a real token.** `api.spec.ts` places an order and
  exports it through a real oRPC client, with a token
  [`localIssuer`](/reference/testing#localissuer-options) really signed, and
  asserts the `FORBIDDEN` the rule produced.
- **The row.** `examples/order-infrastructure`'s `rls.spec.ts` runs against the
  real PostgreSQL: a connection nothing pinned matches no row, a pinned one
  sees its own tenant's rows only, and the role the application connects as is
  neither a superuser nor exempt from row security.

**Two refusals share the `403`, and the payload is what tells them apart.**
Layer 1's is the starter's: a bare `ORPCError("FORBIDDEN")` thrown before
dispatch, never the contract's `errors.FORBIDDEN`, so it is not inferable,
carries no `data`, and reaches a client as a **defect**. Layer 3's is the rule's: `errors.FORBIDDEN({ data: { id, reason } })`,
declared on the contract, so it is inferable and arrives as a **value** on the
`Err` channel. `api.spec.ts` asserts both, and the assertion that separates
them is the `data` — which is why the contract declares one at all.

## See also

- [Protect a procedure](/how-to/protect-a-procedure) — layer 1 in full: the
  marker, the schemes behind it, and what a rejected caller gets.
- [Open a per-request scope](/how-to/open-a-per-request-scope) — layer 2 in
  full: the fork, the kinds, and the gate on the kinds a root binds.
- [`@btravstack/prisma`](/reference/prisma) — the floor: `tenantScoped`, the
  policy DDL, and the role rule.
- [`@btravstack/contract`](/reference/contract) — what the marker models, and
  why resource-dependent authorization is not part of it.
- [Order API (HTTP)](/examples/order-api) — the deployment all four layers are
  quoted from.
