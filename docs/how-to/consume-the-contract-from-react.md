---
title: Consume the contract from React
description: Build a typed browser client from the contract alone, wire it to TanStack Query, page an endpoint with useInfiniteQuery, and configure the CORS and credentials the browser needs.
---

<!-- doctest: prelude
declare const token: string;
-->

# Consume the contract from React

> **How-to.** The lesson that fronts this recipe:
> [Getting started](/tutorial/getting-started).
> A contract is a package a client may take **without** the server, so the
> browser gets the same types the handler was written against. For the
> contract's own surface see
> [`@btravstack/contract`](/reference/contract); for the server half,
> [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http).

Contract-first pays off twice, and the second time is here: the frontend
imports the **contract package**, never the server's, and every call, input,
output and declared error arrives typed. Renaming a field breaks the component
that reads it, in the same `tsc` run that breaks the handler.

Four moves: **depend on the contract alone**, **build the client**, **wrap it
in TanStack Query**, **let the server say who may call it**.

## Step 1 — depend on the contract, not the server

```sh
pnpm add @orpc/client@^2.0.0-beta @orpc/contract@^2.0.0-beta @unthrown/orpc \
  @tanstack/react-query @orpc/tanstack-query@^2.0.0-beta your-api-contract
```

`@orpc/server` is **not** in that list, and that is the point. A contract
package declares its schemas and nothing else — `examples/order-api-contract`
has a `layering.test-d.ts` whose whole job is to fail if the server ever leaks
into the client's graph. Ship the server into a browser bundle once and you
ship your handlers with it.

## Step 2 — build the client from the contract

```ts
import type { contract } from "@btravstack/example-order-api-contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { createResultClient, type ResultClient } from "@unthrown/orpc/client";

type Wire = RouterContractClient<typeof contract>;
export type OrderApiClient = ResultClient<Wire>;

export const createClient = (origin: string, bearer: string): OrderApiClient =>
  createResultClient(
    createORPCClient<Wire>(
      new RPCLink({
        origin,
        url: "/rpc",
        headers: { authorization: `Bearer ${bearer}` },
      }),
    ),
  );
```

`createResultClient` is what keeps the two channels intact across the wire: a
declared error comes back on the `Err` channel typed by `code`, and everything
else — a network failure, a defect the server collapsed to
`INTERNAL_SERVER_ERROR` — comes back as a `Defect`. A component therefore never
writes `try`/`catch`, and never mistakes "the order already exists" for "the
network is down".

## Step 3 — wrap it in TanStack Query

`@orpc/tanstack-query` turns the client into query-option builders. It peers on
`@tanstack/query-core` only, so nothing about this step is React-specific — the
same object works in Solid, Svelte and Vue.

**Hand it the raw oRPC client, not the `Result` one.** TanStack Query's own
contract is a _throwing_ promise: a rejection is how it decides a query failed,
and an `AsyncResult` never rejects, so a `ResultClient` under `useQuery` would
report every failure as a success carrying an `Err` nobody looks at. TanStack
already has the two channels — `data` and `error` — so wrapping them again
would only hide one. Use `createResultClient` for the imperative calls a
mutation handler makes, and the raw client here.

```ts
import type { contract } from "@btravstack/example-order-api-contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

const client = createORPCClient<RouterContractClient<typeof contract>>(
  new RPCLink({
    origin: "https://api.example",
    url: "/rpc",
    headers: { authorization: `Bearer ${token}` },
  }),
);

export const orpc = createTanstackQueryUtils(client);

/**
 * A page at a time, in both directions.
 *
 * **The page param carries its DIRECTION, not just a cursor.** TanStack hands
 * `input` whatever the last `getNextPageParam` or `getPreviousPageParam`
 * returned, and it does not say which — so a bare string would be sent as
 * `after` even when it came from `previousCursor`, which asks for the wrong
 * page. Making the param `{ after }` or `{ before }` is what keeps the two
 * directions apart, and it spreads into the exactly-one-cursor shape the
 * contract refuses to see violated.
 */
type Cursor = { readonly after: string } | { readonly before: string } | undefined;

export const ordersPages = orpc.orders.list.infiniteOptions({
  input: (cursor: Cursor) => ({ limit: 20, ...cursor }),
  getNextPageParam: (page): Cursor =>
    page.hasNextPage ? { after: page.nextCursor } : undefined,
  getPreviousPageParam: (page): Cursor =>
    page.hasPreviousPage ? { before: page.previousCursor } : undefined,
  initialPageParam: undefined as Cursor,
});
```

Those two lines are the reason a page's flag and its cursor are **one fact** in
[`orders.list`](/examples/order-api)'s output: `hasNextPage: true` carries the
`nextCursor` that continues the listing, and `hasNextPage: false` has no
`nextCursor` field at all. Reading the flag is therefore what hands the cursor
over — typed `string`, with no null to widen it and no `?? ""` to invent one —
and "there are no more pages that way" is the flag, which every arm of the
schema requires. A page with a flag and no cursor, or a cursor nobody may use,
is refused by the server's own output schema before it reaches you.

The cursors are **opaque**. The contract types them `z.string()` and nothing
narrower, so a component passes back a string it never parses — and the server
is free to change what a cursor means without a contract change.

**A page runs in one direction.** The contract takes `after` and `before` and
refuses both at once; the application's `PageRequest` makes them a union, so the
schema refusal and the type say the same thing at the two ends of the wire.
"After X and before Y" is a range query wearing a page's clothes, and TanStack
asks in one direction at a time anyway.

Then, in a component:

<!-- doctest: skip — needs `react`, which no example workspace installs; the options object it receives is compiled by the fence above -->

```tsx
import { useInfiniteQuery } from "@tanstack/react-query";

export const Orders = () => {
  const { data, fetchNextPage, hasNextPage } = useInfiniteQuery(ordersPages);

  return (
    <>
      {data?.pages.flatMap((page) => page.items).map((order) => (
        <p key={order.id}>{order.quantity}</p>
      ))}
      {hasNextPage ? <button onClick={() => fetchNextPage()}>More</button> : null}
    </>
  );
};
```

`order.quantity` is typed `number` because the contract said so, and
`order.id` carries the `"OrderId"` brand — so an order id cannot be passed
where a customer id goes, in the browser, for free.

## Step 4 — let the server say who may call it

A browser on another origin is refused by default. CORS is **configuration on
the handler**, not a middleware slot:

```ts
import { HttpModule } from "@btravstack/http-server";
```

<!-- doctest: skip — an options excerpt of the HttpModule call compiled by docs/examples/order-api.md; the option itself is typed by docs/reference/http-server.md's own fence -->

```ts
HttpModule("OrderApi")({
  router,
  cors: { origin: "https://orders.example", credentials: true },
  // …
});
```

Three things a browser client needs and a Node one does not:

- **`origin`** must be the exact origin the app is served from, never `"*"`
  once credentials are involved — the browser refuses that combination itself.
- **`credentials: true`** only if you are sending cookies. A `Bearer` header
  needs no credentials mode, which is one reason this stack's authenticators
  read a header rather than a cookie today (see
  [Protect a procedure](/how-to/protect-a-procedure)).
- **The environment sets it in production.** `cors` is the pin;
  `HTTP_CORS_ORIGIN` is what a deployment sets, because the origin calling you
  varies per environment and belongs in the manifest rather than the image. See
  [Configure from the environment](/how-to/configure-from-the-environment).

## What you do not get

**No generated client, and no generation step.** The client IS the contract
under a type alias, so there is nothing to regenerate and nothing to fall out
of date — the failure mode of every OpenAPI codegen pipeline. The cost is that
the client must be written in TypeScript against the same contract package; a
consumer in another language wants the
[OpenAPI document](/reference/http-server) instead.

**No React bindings of this framework's own.** `@orpc/tanstack-query` is
upstream's, and it is better than anything shipped here would be. The
`@btravstack/*` packages stop at the server.
