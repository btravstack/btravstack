import { expect, test } from "vitest";
import { z } from "zod";

import { Entity } from "./index.js";

const InvoiceId = z.uuid().brand("InvoiceId");
const Sku = z.string().min(1).brand("Sku");
const Quantity = z.number().int().brand("Quantity");
const Sequence = z.number().int().positive().brand("Sequence");
const Instant = z.iso.datetime().brand("Instant");

class Line extends Entity("Line")(
  { sku: Sku, quantity: Quantity },
  {
    invariants: [
      Entity.invariant({
        code: "EMPTY_LINE",
        ensure: (d) => d.quantity > 0,
        message: "a line orders at least one unit",
      }),
    ],
  },
) {}

/** A sequence number is assigned under a row lock, long after the command arrived. */
class Invoice extends Entity("Invoice")(
  {
    id: Entity.field(InvoiceId, { generated: true, immutable: true }),
    number: Entity.field(Sequence, { generated: true, immutable: true }),
    issuedAt: Entity.field(Instant, { generated: true, immutable: true }),
    dueAt: Instant,
    lines: z.array(Line),
  },
  {
    invariants: [
      Entity.invariant({
        code: "DUE_BEFORE_ISSUE",
        ensure: (d) => d.dueAt > d.issuedAt,
        message: "an invoice falls due after it is issued",
      }),
    ],
  },
) {}

const command = { dueAt: "2026-11-01T09:00:00Z", lines: [{ sku: "A-1", quantity: 2 }] };

const createInvoice = Invoice.factory({
  id: () => "0199b1f4-1b1e-7000-8000-000000000001",
  number: () => 42,
  issuedAt: () => "2026-10-09T09:00:00Z",
});

test("a create command parses to the caller's fields, a smuggled generated key dropped", () => {
  // GIVEN a command that also tries to set a generated field
  const raw = { ...command, number: 7 };

  // WHEN it is parsed
  const parsed = Invoice.parseCreate(raw).map((input) => ({
    keys: Object.keys(input).sort(),
    line: input.lines[0]?.toJSON(),
  }));

  // THEN only the caller's fields are left, the nested line built as an entity
  expect(parsed).toBeOkWith({ keys: ["dueAt", "lines"], line: { sku: "A-1", quantity: 2 } });
});

test("a malformed field is the entity's own InvalidEntity, with its path", () => {
  // GIVEN a command whose due date is not an instant
  const raw = { ...command, dueAt: "next week" };

  // WHEN it is parsed
  const parsed = Invoice.parseCreate(raw);

  // THEN the error is the shape `make` would have answered
  expect(parsed).toBeErrWith(
    expect.objectContaining({
      _tag: "InvalidEntity",
      entity: "Invoice",
      issues: [expect.objectContaining({ path: ["dueAt"] })],
    }),
  );
});

test("a nested entity is held to its own rules before anything is generated", () => {
  // GIVEN a command carrying a line that breaks the line's invariant
  const raw = { ...command, lines: [{ sku: "A-1", quantity: 0 }] };

  // WHEN it is parsed
  const parsed = Invoice.parseCreate(raw);

  // THEN the line's rule refused it, at the line's path
  expect(parsed).toBeErrWith(
    expect.objectContaining({
      issues: [expect.objectContaining({ path: ["lines", 0], params: { code: "EMPTY_LINE" } })],
    }),
  );
});

test("the root's own invariants wait for the generated fields", () => {
  // GIVEN a command due before the invoice will be issued — a rule that reads a generated field
  const raw = { ...command, dueAt: "2026-01-01T09:00:00Z" };

  // WHEN it is parsed, then created
  const created = Invoice.parseCreate(raw).flatMap(createInvoice);

  // THEN only the create refused it: the issue is the rule's, with no field path
  expect(created).toBeErrWith(
    expect.objectContaining({
      issues: [
        {
          message: "an invoice falls due after it is issued",
          params: { code: "DUE_BEFORE_ISSUE" },
        },
      ],
    }),
  );
});

test("a parsed command flows into the factory, nested instances included", () => {
  // GIVEN a parsed command
  const parsed = Invoice.parseCreate(command);

  // WHEN the factory creates from it
  const created = parsed.flatMap(createInvoice).map((invoice) => invoice.toJSON());

  // THEN the invoice carries the caller's fields and the generated ones
  expect(created).toBeOkWith({
    id: "0199b1f4-1b1e-7000-8000-000000000001",
    number: 42,
    issuedAt: "2026-10-09T09:00:00Z",
    dueAt: "2026-11-01T09:00:00Z",
    lines: [{ sku: "A-1", quantity: 2 }],
  });
});
