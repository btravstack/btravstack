import { contractInputSchema } from "@btravstack/contract/orpc";
import { ORPCError } from "@orpc/client";
import { oc } from "@orpc/contract";
import SchemaBuilder from "@pothos/core";
import ErrorsPlugin from "@pothos/plugin-errors";
import RelayPlugin from "@pothos/plugin-relay";
import UnthrownPlugin from "@unthrown/pothos";
import { ErrAsync } from "unthrown";
import { z } from "zod";

import OrpcPlugin, { contractInput, type InvalidInput } from "./index.js";

const Item = z.object({ id: z.string() });
const findItem = oc
  .input(Item)
  .output(Item)
  .errors({ ITEM_MISSING: { data: Item } });

const sharedInput: typeof Item = contractInputSchema(findItem);
const graphqlInput: typeof sharedInput = contractInput(findItem);
void graphqlInput;

class MissingItem extends Error {
  constructor(failure: { readonly data: { readonly id: string } }) {
    super(`Missing item ${failure.data.id}`);
  }
}

class InvalidArguments extends Error {
  constructor(failure: InvalidInput) {
    super(failure.message);
  }
}

const shared = { InvalidInput: InvalidArguments };
const builder = new SchemaBuilder<{
  Objects: { Item: z.output<typeof Item> };
  Refusals: typeof shared;
}>({
  plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin],
  orpc: { refusals: shared },
});

builder.queryField("item", (fields) =>
  fields.procedureField(findItem, {
    type: "Item",
    args: { id: fields.arg.string({ required: true }) },
    input: ({ id }) => ({ id }),
    output: Item,
    refusals: { ITEM_MISSING: MissingItem },
    call: () => (input) => ErrAsync(new ORPCError("ITEM_MISSING", { data: input })),
  }),
);
