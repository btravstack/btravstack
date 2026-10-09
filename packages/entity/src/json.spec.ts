import { describe, expect, test } from "vitest";
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
    note: Entity.field(z.string(), { unbranded: true }),
  },
  { computed: { count: Entity.computed(Count, (d) => d.lines.length) } },
) {}

class Card extends Entity("Card")({ kind: z.literal("card"), limit: amount }) {}
class Cash extends Entity("Cash")({ kind: z.literal("cash"), float: amount }) {}
const Payment = Entity.union("kind", [Card, Cash]);

const bill = () =>
  Bill.make({
    id: "b-1",
    total: "12",
    lines: [{ id: "l-1", amount: "5" }],
    note: "net 30",
  }).getOrThrow();

describe("Entity.codec", () => {
  test("takes the wire text and its own decoded value back", () => {
    // GIVEN a bill built from wire text
    const built = bill();

    // WHEN it is rebuilt from its own projection, updated, and nested
    const outcomes = {
      remake: Bill.make(built.toJSON()).isOk(),
      update: built.update({ note: "net 60" }).isOk(),
      nested: built.lines[0] instanceof Line,
    };

    // THEN every path a field's own output re-enters accepts the decoded value
    expect(outcomes).toEqual({ remake: true, update: true, nested: true });
  });

  test("is written as its wire text by z.encode", () => {
    // GIVEN a bill
    // WHEN its stored state is encoded
    const body = z.encode(Bill.output, bill().toJSON() as unknown as z.output<typeof Bill.output>);

    // THEN every codec field is its text, nested ones included
    expect(body).toEqual({
      id: "b-1",
      total: "12",
      lines: [{ id: "l-1", amount: "5" }],
      note: "net 30",
      count: 1,
    });
  });
});

describe("an entity's json", () => {
  test("accepts what z.encode writes for the entity", () => {
    // GIVEN a bill's encoded body
    const body = z.encode(Bill.output, bill().toJSON() as unknown as z.output<typeof Bill.output>);

    // WHEN its json schema parses it
    const parsed = Bill.json.safeParse(body);

    // THEN it is accepted as written
    expect(parsed).toEqual({ success: true, data: body });
  });

  test("converts to JSON Schema, codec fields as their wire form", () => {
    // GIVEN a bill whose stored state holds bigints, nested and optional
    // WHEN its json is converted
    const schema = z.toJSONSchema(Bill.json, { io: "output" });

    // THEN each codec field is the wire text, and every key toJSON() has is there
    expect(schema).toMatchObject({
      properties: {
        id: { type: "string" },
        total: { type: "string", pattern: "^[1-9][0-9]*$" },
        lines: {
          type: "array",
          items: { properties: { amount: { type: "string", pattern: "^[1-9][0-9]*$" } } },
        },
        due: { type: "string" },
        note: { type: "string" },
        count: { type: "integer" },
      },
      required: ["id", "total", "lines", "note", "count"],
    });
  });

  test("is a plain object a contract derives views from", () => {
    // GIVEN a bill's json
    // WHEN a response view is picked from it
    const view = Bill.json.pick({ id: true, total: true, count: true });

    // THEN the view carries exactly those keys
    expect(Object.keys(view.shape)).toEqual(["id", "total", "count"]);
  });

  test("leaves a field with nothing to encode the very same schema", () => {
    // GIVEN a field that is no codec, inside no union
    // WHEN json and output describe it
    // THEN they hold one schema, so a registry keyed on schemas sees one
    expect(Bill.json.shape.note).toBe(Bill.output.shape.note);
  });

  test("keeps every member of a union Entity.codec did not build", () => {
    // GIVEN the codec-or-value union written by hand, codec first
    class HandWritten extends Entity("HandWritten")({
      value: z.union([z.codec(PositiveText, Amount, { decode: BigInt, encode: String }), Amount]),
    }) {}

    // WHEN its json is converted
    // THEN the bigint member is still there, and conversion refuses it: only
    // Entity.codec's union is known to be written as its text
    expect(() => z.toJSONSchema(HandWritten.json, { io: "output" })).toThrow(/BigInt/);
  });

  test("still collapses Entity.codec's union once zod has cloned it", () => {
    // GIVEN an Entity.codec field described, which clones the union
    class Described extends Entity("Described")({ value: amount.describe("an amount") }) {}

    // WHEN its json is converted
    // THEN the field is still the wire text
    expect(z.toJSONSchema(Described.json, { io: "output" })).toMatchObject({
      properties: { value: { type: "string", pattern: "^[1-9][0-9]*$" } },
    });
  });

  test("follows a codec whose wire side is itself a codec", () => {
    // GIVEN a field encoded to a number, then the number to text
    const NumberText = z.codec(z.string().regex(/^[0-9]+$/), z.number().int(), {
      decode: Number,
      encode: String,
    });
    class Chained extends Entity("Chained")({
      value: Entity.codec(NumberText, Amount, {
        decode: (n) => BigInt(n),
        encode: (a) => Number(a),
      }),
    }) {}
    const chained = Chained.make({ value: "7" }).getOrThrow();

    // WHEN its json describes what z.encode writes
    const described = {
      body: z.encode(
        Chained.output,
        chained.toJSON() as unknown as z.output<typeof Chained.output>,
      ),
      schema: z.toJSONSchema(Chained.json, { io: "output" }),
    };

    // THEN both are the text at the end of the chain
    expect(described).toMatchObject({
      body: { value: "7" },
      schema: { properties: { value: { type: "string", pattern: "^[0-9]+$" } } },
    });
  });
});

describe("an Entity.union's json", () => {
  test("is its members' json, discriminated", () => {
    // GIVEN a union of two members holding codec fields
    // WHEN its json is converted
    const schema = z.toJSONSchema(Payment.json, { io: "output" });

    // THEN each branch is the member's wire form
    expect(schema).toMatchObject({
      oneOf: [
        { properties: { kind: { const: "card" }, limit: { type: "string" } } },
        { properties: { kind: { const: "cash" }, float: { type: "string" } } },
      ],
    });
  });
});
