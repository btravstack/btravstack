import { P } from "unthrown";
import { expect, test } from "vitest";
import { z } from "zod";

import { Entity } from "./index.js";

const CustomerId = z.uuid().brand("CustomerId");
const OrderId = z.uuid().brand("OrderId");
const Name = z.string().min(1).brand("Name");
const Upper = z.string().min(1).brand("Upper");
const Line = z.string().min(1).brand("Line");

class Customer extends Entity("Customer")(
  { id: CustomerId, name: Name },
  {
    computed: {
      shout: Entity.computed(Upper, (d) => d.name.toUpperCase()),
    },
  },
) {}

/** An aggregate: an entity whose fields are other entities. */
class Order extends Entity("Order")({
  id: OrderId,
  customer: Customer,
  watchers: z.array(Customer),
  note: Line,
}) {}

const cid = "0199b1f4-1b1e-7000-8000-000000000001";
const cid2 = "0199b1f4-1b1e-7000-8000-000000000002";
const oid = "0199b1f4-1b1e-7000-8000-000000000003";

const raw = {
  id: oid,
  customer: { id: cid, name: "ada" },
  watchers: [{ id: cid2, name: "grace" }],
  note: "rush",
};

test("an entity can declare another entity as a field", () => {
  const order = Order.make(raw).getOrThrow();
  expect(order.customer).toBeInstanceOf(Customer);
  expect(order.customer.name).toBe("ada");
});

test("a nested entity keeps its behaviour and its computed fields", () => {
  const order = Order.make(raw).getOrThrow();
  expect(order.customer.shout).toBe("ADA");
  expect(order.customer._tag).toBe("Customer");
  expect(order.customer.toJSON()).toEqual(
    Customer.make({ id: cid, name: "ada" }).getOrThrow().toJSON(),
  );
});

test("entities nest inside an array field too", () => {
  const order = Order.make(raw).getOrThrow();
  expect(order.watchers[0]).toBeInstanceOf(Customer);
  expect(order.watchers[0]?.shout).toBe("GRACE");
});

test("a nested entity's own validation failure surfaces with its path", () => {
  const issues = Order.make({ ...raw, customer: { id: cid, name: "" } }).match({
    ok: () => [] as readonly (readonly PropertyKey[])[],
    errCases: (m) =>
      m.with(P.tag("InvalidEntity"), (e) => e.issues.map((i) => [...(i.path ?? [])])),
    defect: () => [["DEFECT"]],
  });
  expect(issues).toEqual([["customer", "name"]]);
});

test("JSON.stringify walks nested entities down to plain data", () => {
  const order = Order.make(raw).getOrThrow();
  expect(JSON.parse(JSON.stringify(order))).toEqual({
    id: oid,
    customer: { id: cid, name: "ada", shout: "ADA" },
    watchers: [{ id: cid2, name: "grace", shout: "GRACE" }],
    note: "rush",
  });
});

test("a nested entity survives a round trip through make", () => {
  const order = Order.make(raw).getOrThrow();
  const again = Order.make(JSON.parse(JSON.stringify(order))).getOrThrow();
  expect(again.customer).toBeInstanceOf(Customer);
  expect(again.customer.shout).toBe("ADA");
});

test("updating a sibling field leaves the nested entity intact", () => {
  const order = Order.make(raw).getOrThrow();
  const updated = order.update({ note: "later" as z.infer<typeof Line> }).getOrThrow();
  expect(updated.note).toBe("later");
  expect(updated.customer).toBeInstanceOf(Customer);
  expect(updated.customer.shout).toBe("ADA");
});

test("an invariant can span the outer entity and a nested one", () => {
  class Checked extends Entity("Checked")(
    { id: OrderId, customer: Customer, note: Line },
    {
      invariants: [
        Entity.invariant({
          code: "NOTE_SHORTER_THAN_NAME",
          ensure: (d) => d.note.length >= d.customer.name.length,
          message: "note must be at least as long as the name",
        }),
      ],
    },
  ) {}
  const ok = Checked.make({ id: oid, customer: { id: cid, name: "ada" }, note: "rush" });
  const bad = Checked.make({ id: oid, customer: { id: cid, name: "grace" }, note: "x" });
  expect(ok.isOk()).toBe(true);
  expect(bad.isErr()).toBe(true);
});

test("a nested entity is not re-frozen into uselessness", () => {
  const order = Order.make(raw).getOrThrow();
  // the nested entity locked its own fields; the outer freeze must not have
  // stripped its prototype methods
  expect(typeof order.customer.toJSON).toBe("function");
  expect(order.customer.toJSON()).toEqual({ id: cid, name: "ada", shout: "ADA" });
});

/* ── toJSON's canonical form ───────────────────────────────────────── */

const Label = z.string().min(1).brand("Label");
class Contact extends Entity("Contact")({ id: CustomerId, nickname: Name.optional() }) {}
class Account extends Entity("Account")({
  id: OrderId,
  label: Name.optional(),
  owner: Contact,
  backup: z.optional(Contact),
  members: z.array(Contact),
  meta: z.object({ label: Label.optional() }).brand("Meta"),
}) {}

/** Each depth's own enumerable keys: what a deep-equality diff, a driver and `JSON.stringify` see. */
const keysAt = (account: Account) => {
  const json = account.toJSON();
  return {
    top: Object.keys(json),
    owner: Object.keys(json.owner),
    members: json.members.map((m) => Object.keys(m)),
    meta: Object.keys(json.meta),
  };
};

test.each([
  ["absent", { id: oid, owner: { id: cid }, members: [{ id: cid2 }], meta: {} }],
  [
    "explicitly undefined",
    {
      id: oid,
      label: undefined,
      owner: { id: cid, nickname: undefined },
      backup: undefined,
      members: [{ id: cid2, nickname: undefined }],
      meta: { label: undefined },
    },
  ],
])("toJSON omits an optional field that is %s, at every depth", (_, row) => {
  // GIVEN a row whose optional fields are not set
  // WHEN it is made and projected
  const keys = Account.make(row).map(keysAt);
  // THEN no depth carries a key for them
  expect(keys).toBeOkWith({
    top: ["id", "owner", "members", "meta"],
    owner: ["id"],
    members: [["id"]],
    meta: [],
  });
});

test("toJSON omits an explicitly undefined key inside an object zod already froze", () => {
  // GIVEN `.readonly()` objects, which zod freezes as it parses, alone and in arrays
  const Fixed = z.object({ label: Label.optional() }).readonly();
  class Settings extends Entity("Settings")({
    id: OrderId,
    fixed: Fixed.brand("Fixed"),
    list: z.array(Fixed.brand("Item")),
    frozenList: z.array(Fixed.brand("Item")).readonly(),
  }) {}
  // WHEN a row with an explicit undefined inside each is made
  const row = { label: undefined };
  const json = Settings.make({ id: oid, fixed: row, list: [row], frozenList: [row] }).map((s) =>
    s.toJSON(),
  );
  // THEN every projection is canonical, and still frozen
  expect(
    json.map(({ fixed, list, frozenList }) => ({
      keys: [Object.keys(fixed), Object.keys(list[0]!), Object.keys(frozenList[0]!)],
      frozen: [fixed, list, list[0], frozenList, frozenList[0]].every((v) => Object.isFrozen(v)),
    })),
  ).toBeOkWith({ keys: [[], [], []], frozen: true });
});

test("an absent optional field is still locked", () => {
  // GIVEN an account without a label
  const account = Account.make({ id: oid, owner: { id: cid }, members: [], meta: {} }).getOrThrow();
  // WHEN a caller assigns one
  const assign = () => {
    (account as { label?: unknown }).label = "x";
  };
  // THEN the binding refuses
  expect(assign).toThrow(TypeError);
});
