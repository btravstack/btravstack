import { describe, expect } from "vitest";

import { Book, books, getBook, it, registry } from "./__tests__/test-fixtures.js";
import { callProcedure, loadProcedure, procedureErrors, refusalsOf } from "./procedure-field.js";

describe("procedureField", () => {
  it("answers the procedure's output, decoded", async ({ readBook }) => {
    // GIVEN a field over the catalogue
    // WHEN a book is read
    const answer = await readBook("dune");

    // THEN its page count is decoded from the wire's string
    expect(answer).toMatchInlineSnapshot(`
      {
        "data": {
          "book": {
            "__typename": "Book",
            "pages": "120",
            "title": "dune",
          },
        },
      }
    `);
  });

  it("taps the value it answers", async ({ readBook, tapped }) => {
    // GIVEN a field tapping each book it answers into the context
    // WHEN a book is read
    await readBook("emma");

    // THEN the tap saw it
    expect(tapped).toEqual(["emma"]);
  });

  it("answers a refusal the procedure declares as its registered member", async ({ readBook }) => {
    // GIVEN a title the catalogue does not hold
    // WHEN it is read
    const answer = await readBook("lost");

    // THEN the field answers the union member registered for NOT_FOUND
    expect(answer).toMatchInlineSnapshot(`
      {
        "data": {
          "book": {
            "__typename": "NotFound",
            "message": "No such book",
          },
        },
      }
    `);
  });

  it("refuses input the contract refuses, before calling the procedure", async ({
    readBook,
    tapped,
  }) => {
    // GIVEN a title the contract refuses
    // WHEN it is read
    const answer = await readBook("");

    // THEN the field answers the member registered for InvalidInput, and nothing was read
    expect({ answer, tapped }).toMatchInlineSnapshot(`
      {
        "answer": {
          "data": {
            "book": {
              "__typename": "BadRequest",
              "message": "Input does not satisfy the service contract",
            },
          },
        },
        "tapped": [],
      }
    `);
  });

  it("answers the service refusing access as an error of the operation", async ({ readBook }) => {
    // GIVEN a title the service refuses to an anonymous caller, undeclared
    // WHEN it is read
    const answer = await readBook("anonymous");

    // THEN GraphQL's own error carries the code
    expect({
      data: answer.data,
      errors: answer.errors?.map(({ message, path, extensions }) => ({
        message,
        path,
        extensions,
      })),
    }).toMatchInlineSnapshot(`
      {
        "data": {
          "book": null,
        },
        "errors": [
          {
            "extensions": {
              "code": "UNAUTHORIZED",
            },
            "message": "Service refused access",
            "path": [
              "book",
            ],
          },
        ],
      }
    `);
  });

  it("answers a declared access refusal as an error of the operation too", async ({ readBook }) => {
    // GIVEN a title the procedure declares FORBIDDEN for
    // WHEN it is read
    const answer = await readBook("reserved");

    // THEN it is no member of the field's union
    expect({
      data: answer.data,
      errors: answer.errors?.map(({ message, path, extensions }) => ({
        message,
        path,
        extensions,
      })),
    }).toMatchInlineSnapshot(`
      {
        "data": {
          "book": null,
        },
        "errors": [
          {
            "extensions": {
              "code": "FORBIDDEN",
            },
            "message": "Service refused access",
            "path": [
              "book",
            ],
          },
        ],
      }
    `);
  });

  it("answers an output breaking the contract as a defect", async ({ readBook }) => {
    // GIVEN a book whose page count is no number
    // WHEN it is read
    const answer = await readBook("torn");

    // THEN the field fails, with no code a client could branch on
    expect(answer.errors?.map(({ path, extensions }) => ({ path, extensions })))
      .toMatchInlineSnapshot(`
      [
        {
          "extensions": {},
          "path": [
            "book",
          ],
        },
      ]
    `);
  });
});

describe("procedureConnection", () => {
  it("answers the procedure's page as a connection", async ({ ask }) => {
    // GIVEN a connection over a shelf's loans
    // WHEN its first page is read
    const answer = await ask(`{ loans(shelf: "poetry", first: 3) {
      ... on QueryLoansConnection { edges { cursor node { id } } pageInfo { hasNextPage endCursor } }
    } }`);

    // THEN the page is folded into edges and page info
    expect(answer).toMatchInlineSnapshot(`
      {
        "data": {
          "loans": {
            "edges": [
              {
                "cursor": "loan-0",
                "node": {
                  "id": "loan-0",
                },
              },
              {
                "cursor": "loan-1",
                "node": {
                  "id": "loan-1",
                },
              },
              {
                "cursor": "loan-2",
                "node": {
                  "id": "loan-2",
                },
              },
            ],
            "pageInfo": {
              "endCursor": "loan-2",
              "hasNextPage": true,
            },
          },
        },
      }
    `);
  });

  it("answers a refusal the procedure declares", async ({ ask }) => {
    // GIVEN a shelf the library does not have
    // WHEN its loans are read
    const answer = await ask(`{ loans(shelf: "closed") {
      __typename ... on NotFound { message }
    } }`);

    // THEN the connection answers the registered member
    expect(answer).toMatchInlineSnapshot(`
      {
        "data": {
          "loans": {
            "__typename": "NotFound",
            "message": "No such shelf",
          },
        },
      }
    `);
  });
});

describe("a builder without orpc.refusals", () => {
  it("answers a declared error as an error of the operation", async ({ askUnregistered }) => {
    // GIVEN a schema whose builder was given no registry
    // WHEN a missing book and a closed shelf are read
    const answer = await askUnregistered(`{
      book(title: "lost") { __typename }
      loans(shelf: "closed") { __typename }
    }`);

    // THEN neither field has a union member to answer, so both fail
    expect({
      data: answer.data,
      errors: answer.errors?.map(({ message, path }) => ({ message, path })),
    }).toMatchInlineSnapshot(`
      {
        "data": {
          "book": null,
          "loans": null,
        },
        "errors": [
          {
            "message": "Not Found",
            "path": [
              "book",
            ],
          },
          {
            "message": "Not Found",
            "path": [
              "loans",
            ],
          },
        ],
      }
    `);
  });
});

describe("callProcedure", () => {
  it("keeps a declared refusal of the operation in the error channel", async () => {
    // GIVEN a title the catalogue does not hold
    // WHEN it is called
    const called = await callProcedure(getBook, { title: "lost" }, books, Book);

    // THEN NOT_FOUND is the procedure's modeled failure
    expect(called).toBeErrWith(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("moves a declared access refusal out of the error channel", async () => {
    // GIVEN a title the procedure declares FORBIDDEN for
    // WHEN it is called
    const called = await callProcedure(getBook, { title: "reserved" }, books, Book);

    // THEN it is GraphQL's own error carrying the code, never a modeled failure
    expect(called).toBeDefectWith(
      expect.objectContaining({
        message: "Service refused access",
        extensions: { code: "FORBIDDEN" },
      }),
    );
  });
});

describe("loadProcedure", () => {
  it("answers the decoded value for a key", async () => {
    // GIVEN the catalogue
    // WHEN one key is loaded
    const loaded = await loadProcedure(registry, getBook, books, { title: "dune" }, Book);

    // THEN the value is decoded
    expect(loaded).toEqual({ title: "dune", pages: 120n });
  });

  it("answers the registered refusal for a declared error", async () => {
    // GIVEN a title the catalogue does not hold
    // WHEN it is loaded
    const loaded = await loadProcedure(registry, getBook, books, { title: "lost" }, Book);

    // THEN the key answers the refusal, never failing its batch
    expect(loaded).toEqual(
      expect.objectContaining({ constructor: registry.NOT_FOUND, message: "No such book" }),
    );
  });

  it("answers an access refusal as GraphQL's own error", async () => {
    // GIVEN a title the service refuses to an anonymous caller
    // WHEN it is loaded
    const loaded = await loadProcedure(registry, getBook, books, { title: "anonymous" }, Book);

    // THEN the key answers an error carrying the code
    expect(loaded).toEqual(
      expect.objectContaining({
        message: "Service refused access",
        extensions: { code: "UNAUTHORIZED" },
      }),
    );
  });
});

describe("procedureErrors", () => {
  it("lists the registered refusals a procedure can answer", () => {
    // GIVEN a registry with no member for FORBIDDEN
    // WHEN the errors of a field over the catalogue are read
    const errors = procedureErrors(registry, getBook);

    // THEN the union holds NOT_FOUND's and InvalidInput's members
    expect(errors).toEqual({ types: [registry.NOT_FOUND, registry.InvalidInput] });
  });
});

describe("refusalsOf", () => {
  it("maps each declared code the registry holds, and InvalidInput", () => {
    // GIVEN a registry with no member for FORBIDDEN
    // WHEN the catalogue's refusals are read
    const refusals = refusalsOf(registry, getBook);

    // THEN FORBIDDEN is left out
    expect(refusals).toEqual({
      NOT_FOUND: registry.NOT_FOUND,
      InvalidInput: registry.InvalidInput,
    });
  });

  it("leaves an access code out even when the registry holds a member for it", () => {
    // GIVEN a registry holding a member for FORBIDDEN
    const holdingAccess = { ...registry, FORBIDDEN: registry.NOT_FOUND };

    // WHEN the catalogue's refusals are read
    const refusals = refusalsOf(holdingAccess, getBook);

    // THEN FORBIDDEN is left out: it is answered as GraphQL's own error
    expect(refusals).toEqual({
      NOT_FOUND: registry.NOT_FOUND,
      InvalidInput: registry.InvalidInput,
    });
  });
});
