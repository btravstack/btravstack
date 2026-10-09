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

test("a union Entity.codec did not build keeps every member", () => {
  const AmountAgain = z.bigint().positive().brand("Amount");
  class HandWritten extends Entity("HandWritten")({
    value: z.union([
      z.codec(PositiveText, Amount, { decode: BigInt, encode: String }),
      AmountAgain,
    ]),
  }) {}
  expectTypeOf<z.output<typeof HandWritten.json>["value"]>().toEqualTypeOf<
    string | z.output<typeof AmountAgain>
  >();
});

test("a codec whose wire side is a codec is the text at the end of the chain", () => {
  const NumberText = z.codec(z.string(), z.number(), { decode: Number, encode: String });
  class Chained extends Entity("Chained")({
    value: Entity.codec(NumberText, Amount, { decode: (n) => BigInt(n), encode: Number }),
  }) {}
  expectTypeOf<z.output<typeof Chained.json>["value"]>().toEqualTypeOf<string>();
});

test("an Entity.codec field described is still its wire text", () => {
  class Described extends Entity("Described")({ value: amount.describe("an amount") }) {}
  expectTypeOf<z.output<typeof Described.json>["value"]>().toEqualTypeOf<string>();
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
