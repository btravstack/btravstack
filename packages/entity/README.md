# @btravstack/entity

**A domain-entity builder for [TypeScript](https://www.typescriptlang.org/), on [zod](https://zod.dev) v4 — branded fields, immutable data, sealed construction, and `Result` instead of throws.**

One declaration gives you a type, four derived schemas to build contracts from,
behaviour, and a class that is itself a zod schema — so entities nest inside each other
without losing what makes them entities. Nothing throws: every fallible
operation returns an [`unthrown`](https://github.com/btravstack/unthrown)
`Result`.

```sh
pnpm add @btravstack/entity zod unthrown @unthrown/standard-schema
```

`zod`, `unthrown` and `@unthrown/standard-schema` are peer dependencies. The
zod range is `^4.3.0` — the floor is measured, not guessed: the full surface
typechecks, emits declarations and passes its runtime assertions on 4.3.0.
Nothing here needs a later minor, and monorepos commonly pin one zod across
every package, so the range is kept as wide as it is true.

<!-- doctest: skip — imported by the next sample as a module of its own -->

```ts
// vocabulary.ts — each brand declared once, imported by every entity
import { z } from "zod";

export const OrgId = z.uuid().brand("OrgId");
export const Slug = z.string().min(1).brand("Slug");
export const Instant = z.iso.datetime().brand("Instant");
```

An entity imports its brands from that module; `Entity.field` only adds flags
to one. A free-text field has nothing to be confused with, so it opts out with
`unbranded: true` rather than minting a brand nobody needs.

<!-- doctest: skip — illustrative application wiring uses caller-owned ids, clock and repository -->

```ts
import { z } from "zod";
import { Entity } from "@btravstack/entity";
import { Instant, OrgId, Slug } from "./vocabulary.js";

class Organization extends Entity("Organization")({
  id: Entity.field(OrgId, { generated: true, immutable: true }),
  slug: Entity.field(Slug, { immutable: true }),
  name: Entity.field(z.string().min(1), { unbranded: true }), // free text
  createdAt: Entity.field(Instant, { generated: true, immutable: true }),
}) {
  get greeting(): string {
    return `Welcome, ${this.name}`;
  }
}

// Bind the effect sources once, at your composition root.
const createOrganization = Organization.factory({
  id: () => ids.next(),
  createdAt: () => clock.now(),
});

const org = createOrganization({ slug, name }).getOrThrow();
await db.insert(org.toJSON()); // the stored shape — never `_tag`
const loaded = Organization.make(row).getOrThrow(); // rows, imports, event folds
const renamed = loaded.update({ name: next }).getOrThrow(); // a NEW entity
```

| Schema member | For                                                                           |
| ------------- | ----------------------------------------------------------------------------- |
| `input`       | everything `make()` accepts                                                   |
| `output`      | stored state, internal fields included: pick a response from it, by allowlist |
| `createInput` | what the domain lets a create set — `input` minus the `generated` fields      |
| `updateInput` | what the domain lets change — `input` minus the `immutable` fields, partial   |
| _the class_   | parses to an instance; valid as a field                                       |

The four are building blocks, not a public API. A route picks from them by
allowlist, so an internal field stays internal and a new one stays out until
someone adds it: see [Expose an HTTP
contract](https://btravstack.github.io/btravstack/entity/how-to/http-contract).

`generated`, `immutable`, `identity` and `unbranded` are **flags on the
field**, written with `Entity.field(schema, flags)`; a field carrying none is a
bare schema.
`computed` and `invariants` are the two declaration options.

An entity is **final**. Fields and behaviour shared by several entities go on a
root, `Entity.abstract(name)(fields)`, and extension lives there; a union of
entities is a value you name:

<!-- doctest: skip — variants and their schemas are defined by the consuming application -->

```ts
abstract class AccountBase extends Entity.abstract("Account")({
  id: AccountId,
  label: DisplayName,
}) {
  abstract describe(): string; // every variant owes this — the compiler checks
}

class Personal extends AccountBase.extend("Personal")({
  kind: z.literal("personal"),
}) {
  override describe(): string {
    return `personal ${this.label}`;
  }
}

// `Business` is declared the same way, on the same root
export const Account = Entity.union("kind", [Personal, Business]);
export type Account = Entity.Instance<typeof Account>;

Account.make(row); // Result<Personal | Business, InvalidEntity>
```

A variant is a real instance of its root, so `instanceof` narrows to it, and
`Account` as a type is `Personal | Business`. There is no class form: putting
the union at a base-class position is `TS2507` at the declaration, because a
class's instance type cannot be a union at all (`TS2509`).

## Aggregates

An aggregate root is an entity. It owns the entities inside its boundary, and
every change goes through a method on the root that names the business intent.
The method checks its rules and returns a new root — and, when other parts of
the system should react, the events it produced beside it. Events are optional:
a command with nothing to announce returns the entity alone.

<!-- doctest: skip — invoice fields, errors and events are defined by the consuming application -->

```ts
class Invoice extends Entity("Invoice")({
  id: Entity.field(InvoiceId, { identity: true, immutable: true }),
  status: InvoiceStatus, // "DRAFT" | "ISSUED" | "VOID"
  total: Money,
}) {
  void(): Result<
    { readonly entity: Invoice; readonly events: readonly [InvoiceVoided] },
    InvoiceNotVoidable | Entity.InvalidEntity
  > {
    if (this.status !== "ISSUED") {
      return Err(new InvoiceNotVoidable({ invoiceId: this.id }));
    }
    return this.update({ status: "VOID" }).map((entity) => ({
      entity,
      events: [{ type: "InvoiceVoided", invoiceId: entity.id }] as const,
    }));
  }
}

const { entity, events } = invoice.void().getOrThrow();
// one transaction: the new row, and one outbox row per event
```

The events are not applied back to the root; they tell other modules what
happened, so an accounting service can react to `InvoiceVoided` without the
invoice knowing it exists. `update()` is public, so export commands from the
domain module rather than entities to patch. See [Model an
aggregate](https://btravstack.github.io/btravstack/entity/how-to/model-an-aggregate)
and [Write commands and
events](https://btravstack.github.io/btravstack/entity/how-to/write-commands).

### Event-driven roots

When the root's state should change only through the events it declares,
declare it with `Entity.aggregate` instead. It declares the events and one
handler per event, it has no `update()`, and every successful command returns a
sealed decision. You still choose the storage: the resulting state with an
outbox, or the event stream itself.

<!-- doctest: skip — aggregate events and repository are defined by the consuming application -->

```ts
class Subscription extends Entity.aggregate("Subscription")({
  id: Entity.field(SubscriptionId, { identity: true }), // a root needs an identity
  seats: Seats,
  status: z.enum(["ACTIVE", "CANCELLED"]),
})({
  events: SubscriptionEvent, // a zod discriminated union on `type`
  opens: {
    SubscriptionStarted: (e) => ({
      id: e.subscriptionId,
      seats: e.seats,
      status: "ACTIVE",
    }),
  },
  evolve: {
    // one handler per event, or it does not compile
    SeatsChanged: (r, e) => ({ ...r, seats: e.seats }),
    SubscriptionCancelled: (r) => ({ ...r, status: "CANCELLED" }),
  },
}) {
  changeSeats(seats: number) {
    if (this.status === "CANCELLED") return Err(new SubscriptionIsCancelled());
    return this.emit({ type: "SeatsChanged", seats }); // fold, verify once, decide
  }
}

const decision = subscription.changeSeats(5).getOrThrow();
decision.events; // every event since the load
decision.expectedVersion; // the version the store must still be at
repository.save(decision); // a state row and an outbox, or an event stream
```

Only `emit` and `start` build a decision, so a repository is only ever handed
events that were folded and checked against every invariant. Load with
`make(row, { version })` or `replay(stream)`; the same aggregate persists as
state or as events without touching its declaration. Reach for it only when
you want that constraint; an `Entity` root is the default. See [Model an event-driven
aggregate](https://btravstack.github.io/btravstack/entity/how-to/model-an-event-driven-aggregate).

## Documentation

**[Entity guide](https://btravstack.github.io/btravstack/entity/)**

- [Guarantees and compatibility](https://btravstack.github.io/btravstack/entity/reference/guarantees) — what is enforced, what is left to you, supported Node/TypeScript/zod versions
- [Compared with zod and Effect](https://btravstack.github.io/btravstack/entity/explanation/compared) — one model, three ways
- [Getting started](https://btravstack.github.io/btravstack/entity/tutorial/getting-started) — from nothing to a working entity
- [Reference](https://btravstack.github.io/btravstack/entity/reference/declaration) — every member, option and type
- [Explanation](https://btravstack.github.io/btravstack/entity/explanation/why-entity) — why it is built this way
- How-to: [HTTP contract](https://btravstack.github.io/btravstack/entity/how-to/http-contract) · [persist and rehydrate](https://btravstack.github.io/btravstack/entity/how-to/persist-and-rehydrate) · [model an aggregate](https://btravstack.github.io/btravstack/entity/how-to/model-an-aggregate) · [model an event-driven aggregate](https://btravstack.github.io/btravstack/entity/how-to/model-an-event-driven-aggregate) · [test domain logic](https://btravstack.github.io/btravstack/entity/how-to/test-domain-logic)

## License

[MIT](./LICENSE) © Benoit TRAVERS
