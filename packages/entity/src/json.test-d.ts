import { expectTypeOf, test } from "vitest";
import { z } from "zod";

import { Entity } from "./index.js";

const PositiveText = z.string().regex(/^[1-9][0-9]*$/);
const Amount = z.bigint().positive().brand("Amount");
const amount = Entity.codec(PositiveText, Amount, {
  decode: (text) => BigInt(text),
  encode: (value) => String(value),
});
const BillId = z.string().min(1).brand("BillId");
const LineId = z.string().min(1).brand("LineId");
const Count = z.number().int().brand("Count");

class Line extends Entity("Line")({ id: LineId, amount }) {}
class Bill extends Entity("Bill")(
  {
    id: Entity.field(BillId, { generated: true, identity: true }),
    total: amount,
    lines: z.array(Line),
    due: z.optional(amount),
  },
  { computed: { count: Entity.computed(Count, (d) => d.lines.length) } },
) {}

class Card extends Entity("Card")({ kind: z.literal("card"), limit: amount }) {}
class Cash extends Entity("Cash")({ kind: z.literal("cash"), float: amount }) {}
const Payment = Entity.union("kind", [Card, Cash]);

test("an Entity.codec field accepts the wire text and the decoded value", () => {
  expectTypeOf<z.input<typeof Line.input>["amount"]>().toEqualTypeOf<string | bigint>();
});

test("json types each codec field as its wire text, nested and optional ones included", () => {
  expectTypeOf<z.output<typeof Bill.json>>().toEqualTypeOf<{
    id: z.output<typeof BillId>;
    total: string;
    lines: { id: z.output<typeof LineId>; amount: string }[];
    due?: string | undefined;
    count: z.output<typeof Count>;
  }>();
});

test("a union keeps a decoded member named before its codec", () => {
  class Misordered extends Entity("Misordered")({
    value: z.union([Amount, z.codec(PositiveText, Amount, { decode: BigInt, encode: String })]),
  }) {}
  expectTypeOf<z.output<typeof Misordered.json>["value"]>().toEqualTypeOf<
    z.output<typeof Amount> | string
  >();
});

test("a union value's json is its members' json", () => {
  expectTypeOf<z.output<typeof Payment.json>>().toEqualTypeOf<
    { kind: "card"; limit: string } | { kind: "cash"; float: string }
  >();
});

test("an aggregate carries json too", () => {
  class Account extends Entity.aggregate("Account")({
    id: Entity.field(BillId, { identity: true }),
    balance: amount,
  })({
    events: z.object({ type: z.literal("Opened"), id: z.string(), balance: z.string() }),
    opens: { Opened: (e) => ({ id: e.id, balance: e.balance }) },
    evolve: {},
  }) {}
  expectTypeOf<z.output<typeof Account.json>["balance"]>().toEqualTypeOf<string>();
});
