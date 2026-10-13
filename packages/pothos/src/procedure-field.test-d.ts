import SchemaBuilder from "@pothos/core";
import ErrorsPlugin from "@pothos/plugin-errors";
import RelayPlugin from "@pothos/plugin-relay";
import UnthrownPlugin from "@unthrown/pothos";
import type { AsyncResult } from "unthrown";
import type { z } from "zod";

import {
  BadRequestError,
  Book,
  LoanPage,
  NotFoundError,
  books,
  getBook,
  listLoans,
  loans,
  registry,
} from "./__tests__/test-fixtures.js";
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

uncovered.queryField("localBook", (fields) =>
  fields.procedureField(getBook, {
    type: "Book",
    refusals: { NOT_FOUND: NotFoundError },
    call: () => books,
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

uncovered.queryField("missingLocalCode", (fields) =>
  // @ts-expect-error -- a local map must still cover NOT_FOUND together with the shared defaults
  fields.procedureField(getBook, {
    type: "Book",
    refusals: {},
    call: () => books,
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

covered.queryField("incompatibleOverride", (fields) =>
  // @ts-expect-error -- a local override must accept NOT_FOUND's own failure, even if the shared entry is compatible
  fields.procedureField(getBook, {
    type: "Book",
    refusals: { NOT_FOUND: BadRequestError },
    call: () => books,
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

uncovered.queryField("handledBook", (fields) =>
  fields.procedureField(getBook, {
    type: "Book",
    call: () => (input) =>
      books(input).recoverErrCases((matcher) =>
        matcher
          .with({ code: "NOT_FOUND" }, () => ({ title: "fallback", pages: "0" }))
          .with({ code: "FORBIDDEN" }, () => ({ title: "fallback", pages: "0" })),
      ),
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

const localOnly = new SchemaBuilder<{
  Objects: { Book: { readonly title: string; readonly pages: bigint } };
  Refusals: {};
}>({ plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin] });

localOnly.queryField("book", (fields) =>
  fields.procedureField(getBook, {
    type: "Book",
    refusals: registry,
    call: () => books,
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

localOnly.queryField("missingInputRefusal", (fields) =>
  // @ts-expect-error -- InvalidInput must be covered even when call handles every declared failure itself
  fields.procedureField(getBook, {
    type: "Book",
    refusals: { NOT_FOUND: NotFoundError },
    call: () => (input) =>
      books(input).recoverErrCases((matcher) =>
        matcher
          .with({ code: "NOT_FOUND" }, () => ({ title: "fallback", pages: "0" }))
          .with({ code: "FORBIDDEN" }, () => ({ title: "fallback", pages: "0" })),
      ),
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

const connectionBuilder = new SchemaBuilder<{
  Objects: { Loan: { readonly id: string } };
  Refusals: { readonly InvalidInput: typeof BadRequestError };
}>({
  plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin],
  orpc: { refusals: { InvalidInput: BadRequestError } },
});

connectionBuilder.queryField("loans", (fields) =>
  fields.procedureConnection(listLoans, {
    type: "Loan",
    refusals: { NOT_FOUND: NotFoundError },
    call: () => loans,
    input: () => ({ shelf: "poetry", first: 2 }),
    output: LoanPage,
    connection: () => ({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
  }),
);

connectionBuilder.queryField("uncoveredLoans", (fields) =>
  // @ts-expect-error -- a connection's local map cannot omit NOT_FOUND
  fields.procedureConnection(listLoans, {
    type: "Loan",
    refusals: {},
    call: () => loans,
    input: () => ({ shelf: "poetry", first: 2 }),
    output: LoanPage,
    connection: () => ({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
  }),
);

connectionBuilder.queryField("handledLoans", (fields) =>
  fields.procedureConnection(listLoans, {
    type: "Loan",
    refusals: {},
    call: () => (input) =>
      loans(input).recoverErrCases((matcher) =>
        matcher.with({ code: "NOT_FOUND" }, () => ({ loans: [], more: false })),
      ),
    input: () => ({ shelf: "poetry", first: 2 }),
    output: LoanPage,
    connection: () => ({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
  }),
);

connectionBuilder.queryField("incompatibleLoanOverride", (fields) =>
  // @ts-expect-error -- local connection entries must accept their own code's data
  fields.procedureConnection(listLoans, {
    type: "Loan",
    refusals: { NOT_FOUND: BadRequestError },
    call: () => loans,
    input: () => ({ shelf: "poetry", first: 2 }),
    output: LoanPage,
    connection: () => ({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
  }),
);

const replacedDefaults = new SchemaBuilder<{
  Objects: { Book: z.output<typeof Book>; Loan: { readonly id: string } };
  Refusals: {
    readonly InvalidInput: typeof BadRequestError;
    readonly NOT_FOUND: typeof BadRequestError;
  };
}>({
  plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin],
  orpc: { refusals: { InvalidInput: BadRequestError, NOT_FOUND: BadRequestError } },
});

replacedDefaults.queryField("localBook", (fields) =>
  fields.procedureField(getBook, {
    type: "Book",
    refusals: { NOT_FOUND: NotFoundError },
    call: () => books,
    input: () => ({ title: "dune" }),
    output: Book,
  }),
);

replacedDefaults.queryField("localLoans", (fields) =>
  fields.procedureConnection(listLoans, {
    type: "Loan",
    refusals: { NOT_FOUND: NotFoundError },
    call: () => loans,
    input: () => ({ shelf: "poetry", first: 2 }),
    output: LoanPage,
    connection: () => ({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
  }),
);

type BookFailure =
  ReturnType<typeof books> extends AsyncResult<unknown, infer Failure> ? Failure : never;

covered.queryField("explicitLocalType", (fields) =>
  fields.procedureField<"Book", z.ZodType<{ title: string }, { title: string }>, BookFailure>(
    getBook,
    {
      type: "Book",
      // @ts-expect-error -- explicit generics that default Local to {} cannot pass a map whose overrides coverage would ignore
      refusals: { NOT_FOUND: BadRequestError },
      call: () => books,
      input: () => ({ title: "dune" }),
      output: Book,
    },
  ),
);

connectionBuilder.queryField("explicitLocalConnectionType", (fields) =>
  fields.procedureConnection<
    "Loan",
    z.ZodType<{ shelf: string; first: number }, { shelf: string; first?: number | undefined }>,
    z.output<typeof LoanPage>,
    never,
    false
  >(listLoans, {
    type: "Loan",
    // @ts-expect-error -- defaulting Local to {} must not hide an incompatible InvalidInput override
    refusals: { InvalidInput: NotFoundError },
    call: () => (input) =>
      loans(input).recoverErrCases((matcher) =>
        matcher.with({ code: "NOT_FOUND" }, () => ({ loans: [], more: false })),
      ),
    input: () => ({ shelf: "poetry", first: 2 }),
    output: LoanPage,
    connection: () => ({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
  }),
);
