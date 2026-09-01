---
title: Serve htmx fragments
description: Mint a route with api.HtmxGet or api.HtmxPost, compose it with api.HtmxFragments([...]), and serve it under HttpModule alongside — or instead of — an oRPC router.
---

<!-- doctest: prelude
import { api } from "../../auth.js";
-->

# Serve htmx fragments

> **How-to.** Take a route to an answer that returns `Html`, server-rendered
> and escaped by default, under the same `HttpHandler` set port oRPC answers
> from. For the package's full surface, see
> [`@btravstack/http-server`](/reference/http-server); for the oRPC half this
> composes beside, see
> [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http); for the
> worked deployment, [Order API (HTTP)](/examples/order-api).

A **fragment** here is an htmx route — not an oRPC contract fragment (the
term [Split a router into controllers](/how-to/split-a-router-into-controllers)
uses for a contract sub-tree). A fragment route answers `Html`, not a typed
envelope: a browser navigation is not an RPC call, so there is no client-side
type to infer and no declared error union to branch on — a route's own
triage recovers into rendered markup instead. There is also no separate
contract to declare it against: a route is minted where it is implemented,
method and path as arguments to the mint call itself.

## Recipe

1. Implement a route with `api.HtmxGet(path, options?)(deps, { sync })` or
   `api.HtmxPost(path, options?)(deps, { sync })`, returning `Html` from
   [`html`](/reference/http-server#html-and-raw). `options.requires` marks it
   exactly like an oRPC procedure; `options.input` — `HtmxPost` only —
   validates the decoded form body.
2. Compose every route with `api.HtmxFragments([piece, …])`.
3. Compose the root with `HttpModule({ fragments, imports, exports, needs })`
   — `router` is optional; a fragments-only root drops it.
4. `await runMain(...)`, unchanged from the oRPC recipe.

## Step 1 — the route

```ts
import { FindOrder } from "@btravstack/example-order-application";
import { html } from "@btravstack/http-server";
import { P } from "unthrown";

export const orderRowFragment = api.HtmxGet("/orders/:id/row", { requires: [{ user: [] }] })(
  { find: FindOrder },
  {
    sync:
      ({ find }) =>
      (context, params) =>
        find
          .execute(context.principal.tenantId, params.id)
          .map((order) => html`<tr id="order-${order.id}"><td>${order.quantity}</td></tr>`)
          .recoverErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), () => html`<tr><td>not found</td></tr>`),
          ),
  },
);
```

`path` carries `:name` segments — `ParamsOf<"/orders/:id/row">` is
`{ readonly id: string }`, extracted at the type level and bound at runtime.
`requires: [{ user: [] }]` marks the route exactly as `authenticated(...)`
would mark an oRPC procedure: the same `resolvePrincipal` walk runs, so a
fragment route gets the same `401`/`403` path a procedure does, and
`context` carries the same `principal` a marked procedure's does — here the
tenant comes off the caller's own credential, never off `params`, exactly the
contrast [Protect a procedure](/how-to/protect-a-procedure) draws for the
unmarked case. Drop `requires` and the route is public, with no `principal`
on `context` at all — reading one is a compile error. An ungrantable scope —
one the scheme's own authenticator never grants — fails the compile ending on
`"UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it"`, naming the
scope.

The route's key is `` `${method} ${path}` ``, minted as the port id
`` `HtmxFragment:GET /orders/:id/row` `` — the same move a piece's path takes
under `api.OrpcController(contract, path)`. `.recoverErrCases` is this
route's own triage, at the place a router's `mapErrCases` sits: there is no
declared error union for a client to branch on, so a domain error becomes
rendered markup here or not at all.

Only `api.HtmxPost`'s options carry an `input` field — `api.HtmxGet`'s do
not, so passing one there is a compile error naming the unknown option
rather than a value refused at runtime: unexpressible, not merely refused.
`input` is any Standard Schema over the decoded form body — the same shape
`Config.provider` accepts, so no schema library joins this package for it.
The decoding itself has two stated limits: the body decodes through
`Object.fromEntries(new URLSearchParams(...))`, assuming
`application/x-www-form-urlencoded` with no `content-type` check — a JSON
body reads as one garbage key — and it keeps only the **last** value for a
repeated key — a `<select multiple>` or a checkbox group, both mainstream
htmx shapes, collapse to their last selection rather than an array. Meet
both here rather than in production: a route wanting every value or a
different body format needs its own decoding ahead of `input`.

::: warning
`` html`…` `` escapes every interpolation, but the escaping is
**context-blind**: it protects element text and a _quoted_ attribute value,
and nothing else. An unquoted attribute, an attribute name, a URL scheme
(`href="${url}"` does not vet `javascript:`), and `<script>`/`<style>`
contents are the caller's own responsibility.
:::

oxfmt and prettier treat a tagged template literally named `html` as
embeddable markup and reflow it, inserting real whitespace into the rendered
output. This repo sets `embeddedLanguageFormatting: "off"` for exactly that
reason — a consuming application needs the same setting, or its output
drifts silently the next time a formatter runs.

## Step 2 — compose the pieces

```ts
export const orderFragments = api.HtmxFragments([orderRowFragment]);
```

An array of pieces, no contract argument — mirroring the composing form of
`api.OrpcRouter`, minus the coverage it checks: there is no declared route
set to leave uncovered, so a route not listed here is simply not served.
Two routes minted for the same method and path are two providers for one
port id — di's duplicate-provider defect, exactly as two controllers
claiming one contract path would be.

::: danger
**Routes are matched in this array's own order, first match wins — and that
ordering is a security property, not only a routing one.** Two routes are
two port ids, minted from their own method and path, so di has nothing to
see collide: an unmarked route declared **before** a route that requires
authentication whose path can also match the same request answers it, and
no authentication ever runs. There is deliberately no specificity rule to
fall back on — declare a route that requires authentication before any
unmarked route whose path could also match its requests.
:::

## Step 3 — the composition root

```ts
import { HttpModule } from "@btravstack/http-server";
import { OrderApplicationModule } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { Logger } from "@btravstack/core";
import { observability } from "@btravstack/observability";

export const OrderFragmentsApi = HttpModule("OrderFragmentsApi")({
  fragments: orderFragments,
  provides: [orderRowFragment],
  imports: [OrderApplicationModule, OrderPersistenceModule, observability()],
  exports: [Logger],
});
```

`orderRowFragment` still has to be **provided** somewhere in the graph:
`orderFragments`'s own deps name the `HtmxFragment:GET /orders/:id/row`
**port**, not the provider behind it, exactly as a router composed from
pieces needs each piece's own provider supplied — `examples/order-api`'s
`OrdersSlice` does this by providing `[ordersController, orderRowFragment]`
together, so a real slice carries its own piece rather than leaving it for
the root.

`fragments` is optional exactly as `router` is — supply one, the other, or
both; supplying **neither** is refused at this call, against a
`"SERVES NOTHING — supply a router, fragments, or both"` marker. Fragments
mount at `fragmentsPrefix`, default `/` — a separate field from `prefix`
(the oRPC mount, default `/rpc`), since one option cannot carry two mount
points with two different defaults. A root serving both deduplicates a
scheme shared between `router` and `fragments` by reference before it
reaches `provides`, so an authenticator named by both still resolves once.

Everything else — `main.ts`, `PORT`/`HOST`, the drain, the trace-id policy —
is unchanged from
[Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http#step-4-—-main-ts):
`await runMain(OrderFragmentsApi, { ... })` is the whole process either way.

## Always 200, never a header of its own

A route always answers `200` on success and cannot set a header or a status
itself: `HX-Redirect`, `HX-Trigger`, `HX-Retarget` and `HX-Reswap` — htmx's
own response mechanics — are unreachable, and a route cannot answer its own
`404` or `422`. "Not found" is rendered markup — `orderRowFragment`'s own
`.recoverErrCases` above — never a status. A defensible scope decision, not
an oversight.

Every `200` also carries `Cache-Control: no-store`, unconditional: a public
route can still render a caller- or resource-scoped fragment off a path
parameter alone, and there is no cheaper signal than "never store" for this
package to key the header on.

## CSRF, one release away

This answerer carries no CSRF protection today, for the same reason oRPC's
`GetMethodCsrfProtectionHandlerPlugin` sits unused: it is meaningful only
once a request carries a `SameSite` cookie, and this package configures no
cookies. A fragment's `POST` is form-urlencoded — exactly the request shape
that skips a browser's CORS preflight — so the day a cookie authenticator
lands, CSRF stops being inert for this answerer first.

## See also

- [`@btravstack/http-server`](/reference/http-server) — `html`/`raw`,
  `ParamsOf`, `HtmxGet`, `HtmxPost`, `HtmxFragments`, `htmx()`, and what each
  request is answered with.
- [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) — the
  other answerer, `main.ts` in full, and the options both share.
- [Protect a procedure](/how-to/protect-a-procedure) — the marker, `auth.ts`
  and the scopes this page's authenticator resolves.
- [Order API (HTTP)](/examples/order-api) — the real deployment `orderRow`
  ships in, alongside the router, with a cross-tenant test against real
  Postgres.
