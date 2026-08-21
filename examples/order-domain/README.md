# `@btravstack/core` example: the order domain

The innermost layer. It holds the vocabulary — an `Order`, a `Customer`, the
rule that a quantity must be positive, and the failures the rest of the system
names.
The entity is modelled with
[`@btravstack/entity`](https://github.com/btravstack/entity), which is the
library built for exactly this layer.

```
src/order.ts          the Order entity, its vocabulary, placeOrder, and the domain errors
src/customer.ts       the Customer entity and CustomerNotFound
src/fulfillment.ts    the three failures fulfillment answers with
src/test-fixtures.ts  a placed Order and a Customer, injected as Vitest fixtures
```

## What is deliberately absent

No `@btravstack/di`, no `@btravstack/core`, no ports. A port describes what a
use case needs from the outside world, which is a question this layer does not
ask; ports live one layer out, in `@btravstack/example-order-application`.
The `dependencies` block of `package.json` is the whole statement:

```json
"dependencies": {
  "@btravstack/entity": "catalog:",
  "unthrown": "catalog:",
  "zod": "catalog:"
}
```

Every one of the three is a domain-modelling tool: an entity builder, the schema
layer it is built on, and errors as values. Nothing here can reach a framework.

## The entity

```ts
export const OrderId = z.uuidv7().brand("OrderId");
export const Quantity = z.number().int().brand("Quantity");

export class Order extends Entity("Order")(
  {
    id: Entity.field(OrderId, { immutable: true }),
    quantity: Quantity,
  },
  {
    invariants: [
      Entity.invariant(
        (d) => d.quantity > 0,
        (d) =>
          `order ${d.id} asks for ${d.quantity} items, which is not a positive quantity`,
      ),
    ],
  },
) {}
```

Four things the hand-written `type Order = { id: string; quantity: number }` and
its constructor function could not do:

- **The fields are branded.** An `OrderId` is not a `string` and a `Quantity` is
  not a `number`, so the two cannot be swapped at a call site.
- **`id` is `immutable`.** It is absent from `updateInput`, so `update` refuses
  it at compile time — and rejects it at runtime when it is smuggled past the
  type.
- **The rule is declared once, on the entity.** `Entity.invariant` re-checks it
  on every path that produces an `Order` — `make`, a factory, `update`. The
  `quantity > 0 ? Ok(…) : Err(…)` it replaces guarded only the one path it was
  written on, so any other way of building an order bypassed it.
- **Instances are immutable at runtime.** Every field is installed non-writable
  and deep-frozen, so `readonly` is not merely a compile-time claim.

Nothing throws: `Order.make` and `update` both return an `unthrown` `Result`.

## The rule, as a value

```ts
export const placeOrder = (
  id: string,
  quantity: number,
): Result<Order, InvalidQuantity | InvalidOrderId> =>
  Order.make({ id, quantity }).mapErrCases((matcher) =>
    matcher.with(P.tag("InvalidEntity"), (invalid) =>
      invalid.issues.some((issue) => Entity.keysOf(issue)[0] === "id")
        ? new InvalidOrderId({ id })
        : new InvalidQuantity({ id, quantity }),
    ),
  );
```

`Order.make` validates, runs the invariants and constructs, reporting a
structural failure as `InvalidEntity` with the issues attached. `placeOrder`
names that failure in the layer's own vocabulary, which is what the outer layers
already speak.

**This used to be one error, and `OrderId` is what changed it.** While the id
was an unconstrained string the translation was total — the quantity was the
only field a typed caller could get wrong — so collapsing `InvalidEntity` to
`InvalidQuantity` was sound on its own terms. Giving `OrderId` a UUIDv7 format
added a second way to fail, and the collapse became a mislabelling:
`placeOrder("o-1", 2)` answered _"asks for 2 items, which is not a positive
quantity"_ about a quantity the caller got right. The two are told apart by
**which field** the entity named, never by the message text: a schema issue
carries a `path`, an `Entity.invariant` violation carries none, and
`Entity.keysOf` reads that path as plain keys.

## The other entity earns its place differently

```ts
export class Customer extends Entity("Customer")({
  id: Entity.field(CustomerId, { immutable: true }),
  name: CustomerName,
}) {}
```

No invariant: this layer owns no rule about a name. What `Customer` still buys
is the boundary — the customers repository port is declared over _it_, so an
adapter cannot answer with `CustomerView`, the transport's shape, and the
conversion happens at the controller where it belongs. Branding is not optional
either: `@btravstack/entity` takes nominal fields only, so a bare `z.string()`
name is a compile error at the field map rather than a convention.

`InvalidQuantity` and `InvalidOrderId` are the only failures this layer can
_raise_ — they are the only ones it can decide. `OrderNotFound` and
`DuplicateOrder` are declared here too,
but raised by whoever owns the storage: the domain names them so that every
outer layer speaks about them in the same terms, which is what stops a Prisma
error code or an HTTP status from leaking inwards.

## The dependency rule is a build error

`src/layering.test-d.ts` imports the application layer and expects the import to
fail:

```ts
// @ts-expect-error — the domain layer must not be able to reach the application
// layer: order-domain does not depend on it, so the specifier does not resolve.
import type {} from "@btravstack/example-order-application";
```

Because each layer is its own workspace package, the wrong-direction import does
not resolve (TS2307) — and the `@ts-expect-error` turns "it does not resolve"
into an assertion: add the application layer to this package's dependencies and
the directive goes unused, which `test:types` reports as an error. The guard
fails in both directions, which is what makes it a guard rather than a comment.

## Running it

```bash
pnpm --filter @btravstack/example-order-domain test        # 18 specs
pnpm --filter @btravstack/example-order-domain test:types  # the layering guard
```
