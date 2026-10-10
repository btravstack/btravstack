import SchemaBuilder from "@pothos/core";
import ErrorsPlugin from "@pothos/plugin-errors";
import RelayPlugin from "@pothos/plugin-relay";
import UnthrownPlugin from "@unthrown/pothos";

import { BadRequestError, Book, books, getBook, registry } from "./__tests__/test-fixtures.js";
import OrpcPlugin from "./plugin.js";

// A registry covering every error the procedure declares but the access
// refusals, and InvalidInput, is enough: the field compiles.
const covered = new SchemaBuilder<{
  Objects: { Book: { readonly title: string; readonly pages: bigint } };
  Refusals: typeof registry;
}>({
  plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin],
  orpc: { refusals: registry },
});
covered.queryField("book", (fields) =>
  fields.procedureField(getBook, {
    type: "Book",
    call: () => books,
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

const uncovered = new SchemaBuilder<{
  Objects: { Book: { readonly title: string; readonly pages: bigint } };
  Refusals: { readonly InvalidInput: typeof BadRequestError };
}>({
  plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin],
  orpc: { refusals: { InvalidInput: BadRequestError } },
});
uncovered.queryField("book", (fields) =>
  // @ts-expect-error -- `uncovered: "NOT_FOUND"`: the registry has no refusal for an error the procedure declares
  fields.procedureField(getBook, {
    type: "Book",
    call: () => books,
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

covered.queryField("misspelt", (fields) =>
  fields.procedureField(getBook, {
    type: "Book",
    call: () => books,
    // @ts-expect-error -- the input is the procedure's: `name` is not a field of it
    input: () => ({ name: "dune" }),
    output: Book,
  }),
);
