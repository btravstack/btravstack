import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { contractCall, contractInput, contractOutput } from "./contract.js";

describe("contract", () => {
  it("calls the procedure with the defaults its contract adds", async () => {
    // GIVEN a contract defaulting a shelf's tags
    const shelve = oc.input(z.object({ shelf: z.string(), tags: z.array(z.string()).default([]) }));

    // WHEN it is called without them
    const called = await contractCall(shelve, { shelf: "poetry" }, (validated) =>
      OkAsync(validated),
    );

    // THEN the call receives them
    expect(called).toBeOkWith({ shelf: "poetry", tags: [] });
  });

  it("encodes the input for the wire, codecs run", async () => {
    // GIVEN a contract whose due date travels as text
    const renew = oc.input(
      z.object({
        due: z.codec(z.iso.date(), z.date(), {
          decode: (text) => new Date(text),
          encode: (date) => date.toISOString().slice(0, 10),
        }),
      }),
    );

    // WHEN it is called with a date
    const called = await contractCall(renew, { due: "2026-11-01" }, (validated) =>
      OkAsync(validated),
    );

    // THEN the call receives the wire's spelling
    expect(called).toBeOkWith({ due: "2026-11-01" });
  });

  it("refuses input its contract refuses, without calling it", async () => {
    // GIVEN a contract accepting lowercase shelf names only
    const shelve = oc.input(z.object({ shelf: z.string().regex(/^[a-z]+$/u) }));

    // WHEN it is called with another
    const called = await contractCall(shelve, { shelf: "BAD NAME" }, (validated) =>
      OkAsync(validated),
    );

    // THEN the input is refused
    expect(called).toBeErrTagged("InvalidInput");
  });

  it("answers a defect for a contract holding no Zod input", async () => {
    // GIVEN a contract with no input schema
    const unbound = oc.output(z.string());

    // WHEN it is called
    const called = await contractCall(unbound as never, {}, (validated) => OkAsync(validated));

    // THEN the mistake is the schema's source's, never the request's
    expect(called).toBeDefect();
  });

  it("reads the Zod schema a contract declares for its input", () => {
    // GIVEN a contract's input schema
    const Shelf = z.object({ shelf: z.string() });

    // WHEN it is read back
    const read = contractInput(oc.input(Shelf));

    // THEN it is that very schema
    expect(read).toBe(Shelf);
  });

  it("decodes a procedure's answer", () => {
    // GIVEN a page count travelling as text
    const Pages = z.coerce.bigint();

    // WHEN an answer is decoded
    const decoded = contractOutput(Pages, "120");

    // THEN the field resolves the decoded value
    expect(decoded).toBeOkWith(120n);
  });

  it("answers a defect for an answer breaking its own contract", () => {
    // GIVEN a page count travelling as text
    const Pages = z.coerce.bigint();

    // WHEN an answer that is no number is decoded
    const decoded = contractOutput(Pages, "some");

    // THEN the service broke its contract
    expect(decoded).toBeDefect();
  });
});
