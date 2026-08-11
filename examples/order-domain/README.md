# `@btravstack/start` example: the order domain

The innermost layer. It holds the vocabulary — an `Order`, the rule that a
quantity must be positive, and the three failures the rest of the system names —
and it depends on `unthrown` and nothing else.

```
src/order.ts  Order, placeOrder, and the domain errors
```

## What is deliberately absent

No `@btravstack/di`, no `@btravstack/start`, no ports. A port describes what a
use case needs from the outside world, which is a question this layer does not
ask; ports live one layer out, in `@btravstack/start-example-order-application`.
The `dependencies` block of `package.json` is the whole statement:

```json
"dependencies": { "unthrown": "catalog:" }
```

## The rule, as a value

```ts
export const placeOrder = (
  id: string,
  quantity: number,
): Result<Order, InvalidQuantity> =>
  quantity > 0
    ? Ok({ id, quantity })
    : Err(new InvalidQuantity({ id, quantity }));
```

`InvalidQuantity` is the only failure this layer can _raise_ — it is the only
one it can decide. `OrderNotFound` and `DuplicateOrder` are declared here too,
but raised by whoever owns the storage: the domain names them so that every
outer layer speaks about them in the same terms, which is what stops a Prisma
error code or an HTTP status from leaking inwards.

## The dependency rule is a build error

`src/layering.test-d.ts` imports the application layer and expects the import to
fail:

```ts
// @ts-expect-error — the domain layer must not be able to reach the application
// layer: order-domain does not depend on it, so the specifier does not resolve.
import type {} from "@btravstack/start-example-order-application";
```

Because each layer is its own workspace package, the wrong-direction import does
not resolve (TS2307) — and the `@ts-expect-error` turns "it does not resolve"
into an assertion: add the application layer to this package's dependencies and
the directive goes unused, which `test:types` reports as an error. The guard
fails in both directions, which is what makes it a guard rather than a comment.

## Running it

```bash
pnpm --filter @btravstack/start-example-order-domain test        # 4 specs
pnpm --filter @btravstack/start-example-order-domain test:types  # the layering guard
```
