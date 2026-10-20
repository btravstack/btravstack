---
title: Resolve GraphQL fields from oRPC procedures
description: Build a Pothos schema whose fields call oRPC procedures, with each declared error a typed member of the field's result union.
---

# Resolve GraphQL fields from oRPC procedures

> **How-to.** Expose an oRPC procedure as a GraphQL field: its input validated
> by its own contract, its errors answered as typed union members, and an
> access refusal kept an error of the operation.

Install `@btravstack/pothos` beside the schema's own packages — every one of
them a peer:

```sh
pnpm add @btravstack/pothos @pothos/core @pothos/plugin-errors @pothos/plugin-relay \
  @unthrown/pothos@^0.1.2 graphql unthrown zod \
  @orpc/client@2.0.0-beta.44 @orpc/contract@2.0.0-beta.44
```

The schema is any server's: serve it with
[`@btravstack/graphql-server`](/how-to/serve-graphql) or another one.

## Register shared defaults and field-local refusals

A procedure's contract declares its errors by code. Each field's `refusals`
maps its business codes to GraphQL error classes. Keep shared defaults such as
`InvalidInput` in the builder's `orpc: { refusals }`: it answers the contract
refusing a field's input before the call. Each resource can then own its
business refusal classes without a central file importing every domain.

```ts
import OrpcPlugin, { type InvalidInput } from "@btravstack/pothos";
import type { ORPCError } from "@orpc/client";
import { oc } from "@orpc/contract";
import SchemaBuilder from "@pothos/core";
import ErrorsPlugin from "@pothos/plugin-errors";
import RelayPlugin from "@pothos/plugin-relay";
import UnthrownPlugin from "@unthrown/pothos";
import type { AsyncResult } from "unthrown";
import { z } from "zod";

const Book = z.object({ title: z.string(), pages: z.number() });

const getBook = oc
  .input(z.object({ title: z.string().min(1) }))
  .output(Book)
  .errors({ NOT_FOUND: { data: z.object({ reason: z.string() }) } });

class NotFound extends Error {
  public constructor(failure: { readonly data: { readonly reason: string } }) {
    super(failure.data.reason);
  }
}

class BadRequest extends Error {
  public constructor(failure: InvalidInput) {
    super(failure.message);
  }
}

const refusals = { InvalidInput: BadRequest } as const;

type Catalogue = {
  readonly getBook: (input: {
    readonly title: string;
  }) => AsyncResult<unknown, ORPCError<"NOT_FOUND", { readonly reason: string }>>;
};

const builder = new SchemaBuilder<{
  Context: { readonly catalogue: Catalogue };
  Objects: { Book: z.output<typeof Book> };
  Refusals: typeof refusals;
}>({
  plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin],
  errors: { directResult: true },
  orpc: { refusals },
});
```

`Catalogue` stands for the service's client as the context carries it — an
oRPC client whose calls answer an `AsyncResult`, such as
[`@unthrown/orpc`](https://github.com/btravstack/unthrown)'s.

## Expose the procedure as a field

Each refusal class is an object type, and `procedureField` takes the procedure,
the call, how the field's arguments become its input, and how its answer is
decoded:

```ts
builder.objectType(NotFound, {
  name: "NotFound",
  fields: (t) => ({ message: t.exposeString("message") }),
});
builder.objectType(BadRequest, {
  name: "BadRequest",
  fields: (t) => ({ message: t.exposeString("message") }),
});
builder.objectType("Book", {
  fields: (t) => ({ title: t.exposeString("title"), pages: t.exposeInt("pages") }),
});

builder.queryType({
  fields: (t) => ({
    book: t.procedureField(getBook, {
      type: "Book",
      refusals: { NOT_FOUND: NotFound },
      args: { title: t.arg.string({ required: true }) },
      call: ({ catalogue }) => catalogue.getBook,
      input: ({ title }) => ({ title }),
      output: Book,
    }),
  }),
});
```

The field's type is the union `Book | NotFound | BadRequest`. Local entries
override shared entries for the same code; shared entries not overridden
remain available. Existing builders may keep their whole map in
`orpc.refusals` and omit the field option. What happens on each path:

- **The input is the contract's.** It is parsed by the procedure's own input
  schema — its defaults applied, its codecs run — and encoded back for the
  wire before `call` runs; a schema with a `.transform()` has no wire spelling,
  so `call` gets the input as given. An input the contract refuses is `BadRequest`, and
  the service is never called.
- **A declared error is its registered member.** Together the shared and local
  maps must cover every code `call` can fail with, plus `InvalidInput`. A
  missing code does not compile: the options demand an `uncovered` property
  naming it. A narrower `call` that handles a declared error itself needs no
  entry for that error. Each constructor must accept its own case's failure.
- **An access refusal is an error of the operation.** `UNAUTHORIZED` and
  `FORBIDDEN`, declared or not, become a `GraphQLError` with that code in
  `extensions.code`, which a server masking unexpected errors passes through.
- **Anything else is a defect**, an answer the output schema refuses included:
  the field fails and the server masks it.

`tap` sees each value a field answers, with the context, to prime a request's
cache after a read or a write.

## Page through a connection

`procedureConnection` takes the same options, and `connection` folds the
decoded page into Relay's shape; `connectionType` adds fields of your own
beside its edges and page info. Its `refusals` option merges with the same
builder defaults, with local entries taking precedence and the same coverage
check against the connection's `call`.

## Load through a DataLoader

A field batched through a DataLoader cannot answer a `Result`: the batch
function answers a value or an `Error` per key. `loadProcedure(refusals,
procedure, call, input, output)` is that answer, the refusal instance for a
declared error so one key's failure never fails the batch, and
`procedureErrors(refusals, procedure)` is the field's `errors` option, the
same union `procedureField` would have built.

For the book field above, pass `{ ...refusals, NOT_FOUND: NotFound }` to both
helpers. They already accept a map at the call, so the loader's business
refusals can stay with its resource too.
