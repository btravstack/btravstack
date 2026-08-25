// The HTTP code samples the documentation site ships for this deployment,
// compiled. A sample that stops compiling fails `pnpm typecheck`. Each section
// names the page it mirrors.
//
// This file exists because nothing gated those samples, and they drifted: six
// pages went on calling `PlaceOrder.execute(input.id, input.quantity)` after
// the use cases grew a leading `tenantId` and the `orders` fragment became
// `authenticated`, passing an order id where a tenant goes. Every call below
// is therefore made against the REAL `contract`, the REAL `PlaceOrder` /
// `FindOrder` / `FindCustomer` and the application's own `auth.ts` — a stub
// would have accepted every one of those broken calls, which is exactly how
// the drift survived.
//
// What it does NOT cover: the pages' own contract declarations. `zod` and
// `@btravstack/contract` are `@btravstack/example-order-api-contract`'s
// dependencies, not this workspace's, so the fragments are compiled where they
// live. The controllers below are typed by that contract, so a marker removed
// from it still fails here.

import { Env } from "@btravstack/config";
import { Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";
import {
  contract,
  type CustomerView,
  type OrderView,
} from "@btravstack/example-order-api-contract";
import {
  CustomerApplicationModule,
  FindCustomer,
  FindOrder,
  OrderApplicationModule,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { TenantId, type Customer, type Order } from "@btravstack/example-order-domain";
import {
  CustomerPersistenceModule,
  OrderPersistenceModule,
} from "@btravstack/example-order-infrastructure";
import { HttpAuthenticator, HttpModule, Unauthenticated, granted } from "@btravstack/http-server";
import { observability } from "@btravstack/observability";
import { ErrAsync, OkAsync, P } from "unthrown";

import { api } from "./auth.js";

const view = (order: Order): OrderView => ({ id: order.id, quantity: order.quantity });

const customerViewOf = (customer: Customer): CustomerView => ({
  id: customer.id,
  name: customer.name,
});

// ---------------------------------------------------------------------------
// "Step 2 — a controller per slice" — docs/how-to/split-a-router-into-controllers.md;
// "The slices" — docs/examples/order-api.md; "The kernel maps nothing"'s
// `place` fragment — docs/explanation/the-kernel-maps-nothing.md.
//
// The controllers are `./auth.ts`'s `api`, the one `defineHttp` call this
// application makes: reached through anything else, a marked fragment types
// `principal: never` and every read below is a compile error. That
// substitution is half of what these pages were getting wrong, so it is
// pinned by the import rather than asserted. `place` and `find` read the
// identity bare — one scheme — while `export` narrows a tagged union, which is
// the contrast every page draws and the reason its bodies match the real
// controller's byte for byte.
// ---------------------------------------------------------------------------

const ordersController = api.HttpController("DocsOrdersController", contract.orders)(
  { place: PlaceOrder, find: FindOrder, logger: Logger },
  {
    sync: ({ place, find, logger }) => ({
      place: ({ errors, context }, input) => {
        logger.info("order placement requested", { userId: context.principal.userId });
        return place
          .execute(context.principal.tenantId, input.id, input.quantity)
          .map(view)
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.INVALID_QUANTITY({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("InvalidOrderId"), (error) =>
                errors.BAD_REQUEST({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({ message: error.message, data: { id: error.id } }),
              ),
          );
      },
      find: ({ errors, context }, input) =>
        find
          .execute(context.principal.tenantId, input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
      export: ({ context }) => {
        switch (context.principal.scheme) {
          case "user":
            logger.info("order export requested", {
              userId: context.principal.identity.userId,
            });
            return OkAsync({ csv: `user,${context.principal.identity.userId}` });
          case "service":
            logger.info("order export requested", {
              appId: context.principal.identity.appId,
            });
            return OkAsync({ csv: `service,${context.principal.identity.appId}` });
        }
      },
    }),
  },
);

// The unmarked half, and the contrast every page draws: no `principal` on the
// context at all, the tenant off the input instead.
const customersController = api.HttpController("DocsCustomersController", contract.customers)(
  { find: FindCustomer },
  {
    sync: ({ find }) => ({
      find: ({ errors }, input) =>
        find
          .execute(TenantId(input.tenantId), input.id)
          .map(customerViewOf)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("CustomerNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
    }),
  },
);

const DocsOrdersSlice = Module("DocsOrdersSlice")({
  needs: [Env, Logger],
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [ordersController],
  exports: [ordersController],
});

const DocsCustomersSlice = Module("DocsCustomersSlice")({
  needs: [Env],
  imports: [CustomerApplicationModule, CustomerPersistenceModule],
  provides: [customersController],
  exports: [customersController],
});

// ---------------------------------------------------------------------------
// "Step 3 — the keyed root" — docs/how-to/split-a-router-into-controllers.md;
// "The router" and "The composition root" — docs/examples/order-api.md.
// ---------------------------------------------------------------------------

const docsRouter = api.HttpRouter(contract)({
  orders: ordersController,
  customers: customersController,
});

const _DocsOrderApi = HttpModule("DocsOrderApi")({
  needs: [Env],
  router: docsRouter,
  imports: [DocsOrdersSlice, DocsCustomersSlice, observability()],
  exports: [Logger],
});

// ---------------------------------------------------------------------------
// "Step 4 — lifting a slice into its own process" —
// docs/how-to/split-a-router-into-controllers.md; the same call quoted in
// docs/examples/order-api.md and docs/reference/http-server.md.
//
// The do-not-break property: the slice, its module and its controller are the
// very ones composed above — a new composition root and one fewer import, not
// a rewrite. The lifted fragment carries its marker, so the lifted root owes
// the same schemes — which the router brings with it, from the same `api`.
// ---------------------------------------------------------------------------

const liftedOrdersRouter = api.HttpRouter(contract.orders)(
  { implementation: ordersController.port },
  { sync: ({ implementation }) => implementation },
);

const _DocsOrdersApi = HttpModule("DocsOrdersApi")({
  needs: [Env],
  router: liftedOrdersRouter,
  imports: [DocsOrdersSlice, observability()],
});

// ---------------------------------------------------------------------------
// "Step 2 — the router, as a provider" — docs/how-to/serve-orpc-over-http.md;
// "`HttpRouter(contract)({ name: Dep }, arm)`" — docs/reference/http-server.md; "At a
// glance" — docs/index.md. The deps form over the same marked fragment, with no
// controller layer: the three pages that show a router rather than a
// controller all reduce to this call.
// ---------------------------------------------------------------------------

const depsOrdersRouter = api.HttpRouter(contract.orders)(
  { place: PlaceOrder, find: FindOrder },
  {
    sync: ({ place, find }) => ({
      place: ({ errors, context }, input) =>
        place
          .execute(context.principal.tenantId, input.id, input.quantity)
          .map(view)
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.INVALID_QUANTITY({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("InvalidOrderId"), (error) =>
                errors.BAD_REQUEST({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({ message: error.message, data: { id: error.id } }),
              ),
          ),
      find: ({ errors, context }, input) =>
        find
          .execute(context.principal.tenantId, input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
      export: ({ context }) => {
        switch (context.principal.scheme) {
          case "user":
            return OkAsync({ csv: `user,${context.principal.identity.userId}` });
          case "service":
            return OkAsync({ csv: `service,${context.principal.identity.appId}` });
        }
      },
    }),
  },
);

const _DocsDepsApi = HttpModule("DocsDepsApi")({
  needs: [Env],
  router: depsOrdersRouter,
  imports: [OrderApplicationModule, OrderPersistenceModule, observability()],
  exports: [Logger],
});

// ---------------------------------------------------------------------------
// "Declare the schemes" — docs/how-to/protect-a-procedure.md, and "One file
// per application" — docs/examples/order-api.md.
//
// The authenticator half of those pages was ungated until it drifted: both
// showed a scoped scheme answering a hand-built `{ identity, scopes }`, which
// does not type-check — and, cast past, is read as a BARE identity, so every
// caller on a scoped route is refused forever. Pinned here so the next reader
// of those pages is reading something that compiles.
// ---------------------------------------------------------------------------

const _docsUserAuth = HttpAuthenticator<
  { readonly tenantId: TenantId; readonly userId: string },
  "orders:export"
>()({
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const [tenantId, userId, ...rest] = token.split(":");
    const claimed = rest.join(":");
    return tenantId === undefined || tenantId === "" || userId === undefined || userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync(
          granted(
            { tenantId: TenantId(tenantId), userId },
            claimed
              .split(",")
              .filter((scope): scope is "orders:export" => scope === "orders:export"),
          ),
        );
  },
});
