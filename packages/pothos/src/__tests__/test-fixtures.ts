import { ORPCError } from "@orpc/client";
import { oc } from "@orpc/contract";
import SchemaBuilder from "@pothos/core";
import ErrorsPlugin from "@pothos/plugin-errors";
import RelayPlugin from "@pothos/plugin-relay";
import UnthrownPlugin from "@unthrown/pothos";
import DataLoader from "dataloader";
import { GraphQLError, graphql, type ExecutionResult } from "graphql";
import { createYoga } from "graphql-yoga";
import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";
import { test } from "vitest";
import { z } from "zod";

import type { InvalidInput } from "../contract.js";
import OrpcPlugin from "../plugin.js";
import { loadProcedure, procedureErrors } from "../procedure-field.js";

const Reason = z.object({ reason: z.string() });

/** A library's catalogue, read one book at a time by its title. */
export const getBook = oc
  .input(z.object({ title: z.string().min(1) }))
  .output(z.object({ title: z.string(), pages: z.string() }))
  .errors({ NOT_FOUND: { data: Reason }, FORBIDDEN: { data: Reason } });

/** The loans of one shelf, a page at a time. */
export const listLoans = oc
  .input(z.object({ shelf: z.string(), first: z.number().int().positive().default(2) }))
  .output(z.object({ loans: z.array(z.object({ id: z.string() })), more: z.boolean() }))
  .errors({ NOT_FOUND: { data: Reason } });

/** A book as the schema resolves it: its page count decoded from the wire's string. */
export const Book = z.object({ title: z.string(), pages: z.coerce.bigint() });

export const LoanPage = z.object({
  loans: z.array(z.object({ id: z.string() })),
  more: z.boolean(),
});

export class NotFoundError extends Error {
  public override name = "NotFoundError";

  public constructor(failure: { readonly data: { readonly reason: string } }) {
    super(failure.data.reason);
  }
}

export class BadRequestError extends Error {
  public override name = "BadRequestError";

  public constructor(failure: InvalidInput) {
    super(failure.message);
  }
}

export const registry = { NOT_FOUND: NotFoundError, InvalidInput: BadRequestError } as const;

type BookFailure =
  | ORPCError<"NOT_FOUND", { readonly reason: string }>
  | ORPCError<"FORBIDDEN", { readonly reason: string }>;

/** The catalogue as its client answers: what each title stands for. */
export const books = (input: { readonly title: string }): AsyncResult<unknown, BookFailure> => {
  switch (input.title) {
    case "lost":
      return ErrAsync(new ORPCError("NOT_FOUND", { data: { reason: "No such book" } }));
    case "anonymous":
      return fromSafePromise(Promise.reject(new ORPCError("UNAUTHORIZED")));
    case "reserved":
      return ErrAsync(new ORPCError("FORBIDDEN", { data: { reason: "Reading room only" } }));
    case "thrown":
      return fromSafePromise(
        Promise.reject(new ORPCError("NOT_FOUND", { data: { reason: "Private lookup details" } })),
      );
    case "leaked":
      return fromSafePromise(
        Promise.reject(
          new GraphQLError("Private service details", { extensions: { code: "FORBIDDEN" } }),
        ),
      );
    case "torn":
      return OkAsync({ title: input.title, pages: "some" });
    default:
      return OkAsync({ title: input.title, pages: "120" });
  }
};

const loans = (input: {
  readonly shelf: string;
  readonly first?: number | undefined;
}): AsyncResult<unknown, ORPCError<"NOT_FOUND", { readonly reason: string }>> =>
  input.shelf === "anonymous" || input.shelf === "reserved"
    ? fromSafePromise(
        Promise.reject(new ORPCError(input.shelf === "anonymous" ? "UNAUTHORIZED" : "FORBIDDEN")),
      )
    : input.shelf === "closed"
      ? ErrAsync(new ORPCError("NOT_FOUND", { data: { reason: "No such shelf" } }))
      : OkAsync({
          loans: Array.from({ length: input.first ?? 0 }, (_, index) => ({ id: `loan-${index}` })),
          more: true,
        });

type Library = {
  Context: { readonly tapped: string[] };
  Objects: { Book: z.output<typeof Book>; Loan: { readonly id: string } };
  Refusals: typeof registry;
};

const libraryOf = (registered: boolean, defaults = false) => {
  const builder = new SchemaBuilder<Library>({
    plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin],
    errors: { directResult: true, defaultTypes: defaults ? [Error] : [] },
    ...(registered ? { orpc: { refusals: registry } } : {}),
  });
  if (defaults) {
    builder.objectType(Error, {
      name: "Error",
      fields: (fields) => ({ message: fields.exposeString("message") }),
    });
  }
  const loader = new DataLoader<string, z.output<typeof Book>>(async (titles) =>
    Promise.all(titles.map((title) => loadProcedure(registry, getBook, books, { title }, Book))),
  );
  builder.objectType(NotFoundError, {
    name: "NotFound",
    fields: (fields) => ({ message: fields.exposeString("message") }),
  });
  builder.objectType(BadRequestError, {
    name: "BadRequest",
    fields: (fields) => ({ message: fields.exposeString("message") }),
  });
  builder.objectType("Book", {
    fields: (fields) => ({
      title: fields.exposeString("title"),
      pages: fields.string({ resolve: (book) => book.pages.toString() }),
    }),
  });
  builder.objectType("Loan", { fields: (fields) => ({ id: fields.exposeID("id") }) });
  builder.queryType({
    fields: (fields) => ({
      loadedBook: fields.field({
        type: "Book",
        args: { title: fields.arg.string({ required: true }) },
        errors: procedureErrors(registry, getBook),
        resolve: (_, { title }) => loader.load(title),
      }),
      book: fields.procedureField(getBook, {
        type: "Book",
        args: { title: fields.arg.string({ required: true }) },
        call: () => books,
        input: ({ title }) => ({ title }),
        output: Book,
        tap: (book, { tapped }) => {
          tapped.push(book.title);
        },
      }),
      loans: fields.procedureConnection(listLoans, {
        type: "Loan",
        args: { shelf: fields.arg.string({ required: true }) },
        call: () => loans,
        input: ({ shelf, first }) => ({ shelf, first: first ?? undefined }),
        output: LoanPage,
        connection: (page) => ({
          edges: page.loans.map((loan) => ({ cursor: loan.id, node: loan })),
          pageInfo: {
            hasNextPage: page.more,
            hasPreviousPage: false,
            startCursor: page.loans.at(0)?.id ?? null,
            endCursor: page.loans.at(-1)?.id ?? null,
          },
        }),
      }),
    }),
  });
  return builder.toSchema();
};

export const it = test.extend<{
  readonly tapped: string[];
  readonly ask: (source: string) => Promise<ExecutionResult>;
  readonly askUnregistered: (source: string) => Promise<ExecutionResult>;
  readonly askMaskedWithDefaults: (source: string) => Promise<ExecutionResult>;
  readonly askMasked: (source: string) => Promise<ExecutionResult>;
  readonly readBook: (title: string) => Promise<ExecutionResult>;
}>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tapped: async ({}, use) => {
    await use([]);
  },
  ask: async ({ tapped }, use) => {
    const schema = libraryOf(true);
    await use((source) => graphql({ schema, source, contextValue: { tapped } }));
  },
  askUnregistered: async ({ tapped }, use) => {
    const schema = libraryOf(false);
    await use((source) => graphql({ schema, source, contextValue: { tapped } }));
  },
  askMasked: async ({ tapped }, use) => {
    const yoga = createYoga({ schema: libraryOf(true), context: { tapped }, logging: false });
    await use(async (query) => {
      const response = await yoga.fetch("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      return response.json() as Promise<ExecutionResult>;
    });
  },
  askMaskedWithDefaults: async ({ tapped }, use) => {
    const yoga = createYoga({ schema: libraryOf(true, true), context: { tapped }, logging: false });
    await use(async (query) => {
      const response = await yoga.fetch("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      return response.json() as Promise<ExecutionResult>;
    });
  },
  readBook: async ({ ask }, use) => {
    await use((title) =>
      ask(`{ book(title: "${title}") {
        __typename ... on Book { title pages } ... on NotFound { message } ... on BadRequest { message }
      } }`),
    );
  },
});
