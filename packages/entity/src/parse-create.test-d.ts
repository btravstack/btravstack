import type { Result } from "unthrown";
import { z } from "zod";

import { Entity } from "./index.js";

const InvoiceId = z.uuid().brand("InvoiceId");
const Sku = z.string().min(1).brand("Sku");
const Sequence = z.number().int().positive().brand("Sequence");

class Line extends Entity("Line")({ sku: Sku }) {}
class Invoice extends Entity("Invoice")({
  id: Entity.field(InvoiceId, { generated: true, immutable: true }),
  number: Entity.field(Sequence, { generated: true, immutable: true }),
  lines: z.array(Line),
}) {}

const createInvoice = Invoice.factory({ id: () => "x", number: () => 1 });
const parsed = Invoice.parseCreate({});

// what it answers is exactly what the factory's function accepts
const typed: Result<Entity.CreateInput<typeof Invoice>, Entity.InvalidEntity> = parsed;
void typed;

// so a parsed command, nested entities included, flows in with no cast
const created: Result<Invoice, Entity.InvalidEntity> = parsed.flatMap(createInvoice);
void created;

parsed.map((input) => {
  // the nested field is the entity, built under its own rules
  const line: Line | undefined = input.lines[0];
  // @ts-expect-error a generated field is not part of a create command
  void input.number;
  return line;
});

declare const plain: z.output<typeof Invoice.createInput>;
// @ts-expect-error `createInput` holds a nested entity as plain data, which the factory does not take
createInvoice(plain);
