import { Err, P, TaggedError, type Result } from "unthrown";
import { expect, test } from "vitest";
import { z } from "zod";

import { Entity } from "./index.js";

const CartId = z.uuid().brand("CartId");
const ProductId = z.string().min(1).brand("ProductId");
const Quantity = z.number().int().positive().brand("Quantity");
const Item = z.object({ productId: ProductId, quantity: Quantity }).brand("Item");

const CartEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CartOpened"), cartId: z.uuid() }),
  z.object({ type: z.literal("ItemAdded"), productId: z.string(), quantity: z.number().int() }),
  z.object({ type: z.literal("CartCheckedOut") }),
]);
type CartEvent = z.output<typeof CartEvent>;

class CartClosed extends TaggedError("CartClosed") {}

class Cart extends Entity.aggregate("Cart")({
  id: Entity.field(CartId, { identity: true }),
  status: z.enum(["open", "checked_out"]),
  items: z.array(Item),
})({
  events: CartEvent,
  invariants: [
    Entity.invariant({
      code: "TOO_MANY_ITEMS",
      ensure: (d) => d.items.length <= 2,
      message: "a cart holds at most 2 items",
    }),
  ],
  opens: {
    CartOpened: (e) => ({ id: e.cartId, status: "open", items: [] }),
  },
  evolve: {
    ItemAdded: (r, e) => ({
      ...r,
      items: [...r.items, { productId: e.productId, quantity: e.quantity }],
    }),
    CartCheckedOut: (r) => ({ ...r, status: "checked_out" }),
  },
}) {
  addItem(
    productId: string,
    quantity: number,
  ): Result<Entity.Decision<Cart, CartEvent>, CartClosed> {
    if (this.status !== "open") return Err(new CartClosed());
    return this.emit({ type: "ItemAdded", productId, quantity });
  }

  checkOut(): Result<Entity.Decision<Cart, CartEvent>, never> {
    return this.emit({ type: "CartCheckedOut" });
  }
}

const id = "0199b1f4-1b1e-7000-8000-000000000000";
const opened = (): Cart => Cart.start({ type: "CartOpened", cartId: id }).get().state;
/** An open cart as a repository hands it over: stored at version 1, nothing pending. */
const loaded = (): Cart => Cart.make(opened().toJSON(), { version: 1 }).getOrThrow();

/** The outcome of a decision as one comparable value. */
const channel = <T, E>(r: Result<T, E>) =>
  r.match({
    ok: () => "ok",
    // generic in E, so there is nothing to enumerate
    // oxlint-disable-next-line unthrown/no-catch-all-pattern
    errCases: (m) => m.with(P._, () => "err"),
    defect: () => "defect",
  });

test("start opens an aggregate from a creation event and returns a sealed decision", () => {
  const decision = Cart.start({ type: "CartOpened", cartId: id }).get();
  expect(decision.state).toBeInstanceOf(Cart);
  expect(decision.state.toJSON()).toEqual({ id, status: "open", items: [] });
  expect(decision.events).toEqual([{ type: "CartOpened", cartId: id }]);
  // nothing is stored yet
  expect(decision.expectedVersion).toBe(0);
});

test("a method folds its events onto the current state and verifies the result once", () => {
  const cart = loaded();
  const decision = cart.addItem("apple", 2).getOrThrow();
  expect(decision.events).toEqual([{ type: "ItemAdded", productId: "apple", quantity: 2 }]);
  expect(decision.state.items).toEqual([{ productId: "apple", quantity: 2 }]);
  // the source is untouched: a decision is a new state, never a mutation
  expect(cart.items).toEqual([]);
  // the state in the decision is the verified instance, frozen like any entity
  expect(decision.state).toBeInstanceOf(Cart);
  expect(Object.isFrozen(decision.state.items)).toBe(true);
  expect(decision.state.sameIdentityAs(cart)).toBe(true);
});

test("a business check is a typed error, and no events come out of it", () => {
  const closed = opened().checkOut().get().state;
  const result = closed.addItem("apple", 1);
  expect(
    result.match({
      ok: () => "ok",
      errCases: (m) => m.with(P.tag("CartClosed"), () => "closed"),
      defect: () => "defect",
    }),
  ).toBe("closed");
});

test("events that break an invariant are a defect, before anything can be persisted", () => {
  const two = opened().addItem("a", 1).getOrThrow().state.addItem("b", 1).getOrThrow().state;
  expect(channel(two.addItem("c", 1))).toBe("defect");
});

test("an emitted event that does not match the declared schema is a defect", () => {
  const cart = opened();
  expect(channel(cart.emit({ type: "ItemAdded", productId: "x", quantity: 1.5 } as never))).toBe(
    "defect",
  );
  expect(channel(cart.emit({ type: "Nope" } as never))).toBe("defect");
  // a creation event does not compile on an existing aggregate; forced past the type, it is a defect
  expect(channel(cart.emit({ type: "CartOpened", cartId: id } as never))).toBe("defect");
});

test("a throwing handler is a defect", () => {
  class Brittle extends Entity.aggregate("Brittle")({
    id: Entity.field(CartId, { identity: true }),
  })({
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("Opened"), id: z.uuid() }),
      z.object({ type: z.literal("Broke") }),
    ]),
    opens: { Opened: (e) => ({ id: e.id }) },
    evolve: {
      Broke: () => {
        // oxlint-disable-next-line unthrown/no-throw -- the handler bug under test
        throw new Error("boom");
      },
    },
  }) {}
  const brittle = Brittle.start({ type: "Opened", id }).get().state;
  expect(channel(brittle.emit({ type: "Broke" }))).toBe("defect");
});

test("an aggregate method called on an unconstructed object defects", () => {
  // GIVEN an object that bypassed every aggregate constructor
  const fake = {};
  // WHEN its method is invoked with a valid event
  const result = Reflect.apply(Cart.prototype.emit, fake, [{ type: "CartCheckedOut" }]);
  // THEN the missing decision history is a defect
  expect(channel(result as Result<unknown, never>)).toBe("defect");
});

test("start refuses a non-opening event as a defect", () => {
  expect(channel(Cart.start({ type: "CartCheckedOut" } as never))).toBe("defect");
});

/* ── Rehydration ────────────────────────────────────────────────────── */

test("replay folds a stored stream into the same state, and emits nothing", () => {
  const first = Cart.start({ type: "CartOpened", cartId: id }).get();
  const second = first.state.addItem("apple", 2).getOrThrow();
  // the last decision already holds every event since creation
  const stream = second.events;
  expect(stream.map((e) => e.type)).toEqual(["CartOpened", "ItemAdded"]);

  const replayed = Cart.replay(stream).getOrThrow();
  expect(replayed).toBeInstanceOf(Cart);
  expect(replayed.toJSON()).toEqual(second.state.toJSON());
  expect(Object.keys(replayed)).not.toContain("events");
});

test("replay preserves a schema defect in a stored event", () => {
  // GIVEN a schema whose Standard Schema validator defects synchronously
  const events = z.discriminatedUnion("type", [
    z.object({ type: z.literal("Opened"), id: z.uuid() }),
    z.object({ type: z.literal("Closed") }),
  ]);
  Object.defineProperty(events, "~standard", {
    value: {
      validate: () => {
        // oxlint-disable-next-line unthrown/no-throw -- a defective validator is the subject under test
        throw new Error("broken validator");
      },
    },
  });
  class BrokenSchema extends Entity.aggregate("BrokenSchema")({
    id: Entity.field(CartId, { identity: true }),
  })({
    events,
    opens: { Opened: (e) => ({ id: e.id }) },
    evolve: { Closed: (r) => r },
  }) {}
  // WHEN the event is replayed
  const result = BrokenSchema.replay([{ type: "Opened", id }]);
  // THEN parsing's defect stays separate from InvalidEntity
  expect(channel(result)).toBe("defect");
});

test("replay reports a throwing evolution handler as a defect", () => {
  // GIVEN a valid stream whose evolution handler fails
  class BrittleReplay extends Entity.aggregate("BrittleReplay")({
    id: Entity.field(CartId, { identity: true }),
  })({
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("Opened"), id: z.uuid() }),
      z.object({ type: z.literal("Broke") }),
    ]),
    opens: { Opened: (e) => ({ id: e.id }) },
    evolve: {
      Broke: () => {
        // oxlint-disable-next-line unthrown/no-throw -- a defective handler is the subject under test
        throw new Error("boom");
      },
    },
  }) {}
  // WHEN replay invokes the handler
  const result = BrittleReplay.replay([{ type: "Opened", id }, { type: "Broke" }]);
  // THEN the exception stays on the defect channel
  expect(channel(result)).toBe("defect");
});

test("make rehydrates a snapshot, and an aggregate has no update and no factory", () => {
  const snapshot = opened().addItem("apple", 1).getOrThrow().state.toJSON();
  const cart = Cart.make(snapshot, { version: 2 }).getOrThrow();
  expect(cart.items).toHaveLength(1);
  expect("update" in cart).toBe(false);
  expect("factory" in Cart).toBe(false);
  expect("factoryAsync" in Cart).toBe(false);
});

/** Every issue of a failed replay as `[path, message]`. */
const replayIssues = (events: unknown) =>
  Cart.replay(events).match({
    ok: () => [],
    errCases: (m) =>
      m.with(P.tag("InvalidEntity"), (e) =>
        e.issues.map((i) => [Entity.keysOf(i), Entity.codeOf(i) ?? i.message] as const),
      ),
    defect: () => [["defect"]],
  });

test("replay validates every stored event, reporting it at its index", () => {
  const issues = replayIssues([
    { type: "CartOpened", cartId: id },
    { type: "ItemAdded", productId: "apple", quantity: "two" },
  ]);
  expect(issues).toHaveLength(1);
  expect(issues[0]?.[0]).toEqual([1, "quantity"]);
});

test("a stream must start with an opening event", () => {
  expect(replayIssues([])[0]?.[0]).toEqual([]);
  expect(replayIssues([{ type: "CartCheckedOut" }])[0]?.[0]).toEqual([0, "type"]);
  expect(replayIssues({ not: "a stream" })[0]?.[0]).toEqual([]);
});

test("a later opening event mid-stream is refused at its index", () => {
  const issues = replayIssues([
    { type: "CartOpened", cartId: id },
    { type: "CartOpened", cartId: id },
  ]);
  expect(issues[0]?.[0]).toEqual([1, "type"]);
});

test("a stream that breaks today's invariant is an InvalidEntity, like make", () => {
  const issues = replayIssues([
    { type: "CartOpened", cartId: id },
    { type: "ItemAdded", productId: "a", quantity: 1 },
    { type: "ItemAdded", productId: "b", quantity: 1 },
    { type: "ItemAdded", productId: "c", quantity: 1 },
  ]);
  expect(issues).toEqual([[[], "TOO_MANY_ITEMS"]]);
});

test("an aggregate without an identity field is refused while the declaration runs", () => {
  const declare = Entity.aggregate("Anonymous") as unknown as (
    fields: object,
  ) => (options: object) => unknown;
  expect(() =>
    declare({ status: z.enum(["open"]) })({
      events: CartEvent,
      opens: { CartOpened: () => ({ status: "open" }) },
      evolve: { ItemAdded: (r: object) => r, CartCheckedOut: (r: object) => r },
    }),
  ).toThrow(/Anonymous: an aggregate root needs an identity/u);
});

/* ── The version a decision must still find ────────────────────────── */

test("a decision carries the version its state was loaded at", () => {
  const row = opened().toJSON();
  expect(
    Cart.make(row, { version: 7 }).getOrThrow().addItem("a", 1).getOrThrow().expectedVersion,
  ).toBe(7);

  const stream = Cart.start({ type: "CartOpened", cartId: id }).get().events;
  const replayed = Cart.replay([...stream, { type: "ItemAdded", productId: "a", quantity: 1 }]);
  // a stream's version is its length
  expect(replayed.getOrThrow().checkOut().get().expectedVersion).toBe(2);
});

test("chained commands accumulate every event since the load, so saving one decision loses none", () => {
  const first = loaded().addItem("a", 1).getOrThrow();
  const second = first.state.addItem("b", 1).getOrThrow();
  expect(second.events.map((e) => e.type)).toEqual(["ItemAdded", "ItemAdded"]);
  expect(second.expectedVersion).toBe(1);

  // a brand-new aggregate's decisions start from its opening event
  const fresh = opened().addItem("a", 1).getOrThrow();
  expect(fresh.events.map((e) => e.type)).toEqual(["CartOpened", "ItemAdded"]);
  expect(fresh.expectedVersion).toBe(0);
});

test("make without a version is a defect: a loaded aggregate must say what it was loaded at", () => {
  const row = opened().toJSON();
  expect(channel((Cart.make as (s: unknown) => Result<Cart, Entity.InvalidEntity>)(row))).toBe(
    "defect",
  );
});

/* ── Terminal events ───────────────────────────────────────────────── */

class Doc extends Entity.aggregate("Doc")({ id: Entity.field(CartId, { identity: true }) })({
  events: z.discriminatedUnion("type", [
    z.object({ type: z.literal("Opened"), id: z.uuid() }),
    z.object({ type: z.literal("Touched") }),
    z.object({ type: z.literal("Removed") }),
  ]),
  opens: { Opened: (e) => ({ id: e.id }) },
  evolve: { Touched: (r) => r, Removed: (r) => r },
  ends: ["Removed"],
}) {}

const openedDoc = () => Doc.start({ type: "Opened", id }).get();

test("an opening event listed in ends is refused while the declaration runs", () => {
  // GIVEN a declaration the types would refuse, reached untyped
  const declare = Entity.aggregate("Instant")({ id: Entity.field(CartId, { identity: true }) }) as (
    options: object,
  ) => unknown;
  // WHEN it names its opening event as terminal
  const declaring = () =>
    declare({
      events: CartEvent,
      opens: { CartOpened: (e: { cartId: string }) => ({ id: e.cartId }) },
      evolve: { ItemAdded: (r: object) => r, CartCheckedOut: (r: object) => r },
      ends: ["CartOpened"],
    });
  // THEN it throws, naming the event
  expect(declaring).toThrow(/Instant: "CartOpened" opens the aggregate, so it cannot end it/u);
});

test("a decision says whether it ended the aggregate", () => {
  // GIVEN an open document
  const doc = openedDoc().state;
  // WHEN one command changes it and another removes it
  const touched = doc.emit({ type: "Touched" }).get();
  const removed = doc.emit({ type: "Removed" }).get();
  // THEN only the removal is terminal, and opening never is
  expect({
    opened: openedDoc().isTerminal,
    touched: touched.isTerminal,
    removed: removed.isTerminal,
  }).toEqual({ opened: false, touched: false, removed: true });
});

test("a chain ending in a terminal event is one terminal decision", () => {
  // GIVEN an open document
  const doc = openedDoc().state;
  // WHEN one emit touches it, then removes it
  const removed = doc.emit({ type: "Touched" }, { type: "Removed" }).get();
  // THEN the decision holds every event and says the aggregate ended
  expect({ isTerminal: removed.isTerminal, events: removed.events.map((e) => e.type) }).toEqual({
    isTerminal: true,
    events: ["Opened", "Touched", "Removed"],
  });
});

test("nothing can be decided on an ended aggregate", () => {
  // GIVEN a removed document
  const removed = openedDoc().state.emit({ type: "Removed" }).get().state;
  // WHEN a command emits on it anyway
  const result = removed.emit({ type: "Touched" });
  // THEN it is a defect, never a decision to persist
  expect(result).toBeDefect();
});

test("an event after a terminal one in the same emit is a defect", () => {
  // GIVEN an open document
  const doc = openedDoc().state;
  // WHEN an untyped caller emits past the end
  const result = doc.emit(...([{ type: "Removed" }, { type: "Touched" }] as never[]));
  // THEN it is a defect
  expect(result).toBeDefect();
});

test("replay refuses a stream that continues after its terminal event, at that index", () => {
  // GIVEN a stored stream with an event after the removal
  const stream = [{ type: "Opened", id }, { type: "Removed" }, { type: "Touched" }];
  // WHEN it is replayed
  const result = Doc.replay(stream);
  // THEN the event past the end is an InvalidEntity at its index
  expect(result).toBeErrWith(
    expect.objectContaining({
      issues: [{ message: "a stream ends at its terminal event", path: [2, "type"] }],
    }),
  );
});

test("a stream ending at its terminal event replays to an aggregate nothing can decide on", () => {
  // GIVEN a stream ending with a removal
  const replayed = Doc.replay([{ type: "Opened", id }, { type: "Removed" }]).getOrThrow();
  // WHEN a command emits on the replayed state
  const result = replayed.emit({ type: "Touched" });
  // THEN it is a defect
  expect(result).toBeDefect();
});
