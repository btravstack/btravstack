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

  it("parses input through an asynchronous refinement", async () => {
    // GIVEN a contract checking a shelf exists asynchronously
    const shelve = oc.input(
      z.object({ shelf: z.string().refine(async (shelf) => Promise.resolve(shelf === "poetry")) }),
    );

    // WHEN it is called with a shelf that does not exist
    const called = await contractCall(shelve, { shelf: "fiction" }, (validated) =>
      OkAsync(validated),
    );

    // THEN the input is refused, not a defect
    expect(called).toBeErrTagged("InvalidInput");
  });

  it("calls with the input as given when its schema transforms it", async () => {
    // GIVEN a contract normalizing a shelf name with a transform
    const shelve = oc.input(z.object({ shelf: z.string().transform((shelf) => shelf.trim()) }));

    // WHEN it is called
    const called = await contractCall(shelve, { shelf: " poetry " }, (validated) =>
      OkAsync(validated),
    );

    // THEN the call receives the input the contract admitted, as given
    expect(called).toBeOkWith({ shelf: " poetry " });
  });

  it("answers a defect when a codec fails to encode the input", async () => {
    // GIVEN a contract whose codec cannot encode back
    const renew = oc.input(
      z.object({
        due: z.codec(z.iso.date(), z.date(), {
          decode: (text) => new Date(text),
          encode: () => {
            // oxlint-disable-next-line unthrown/no-throw -- the case under test: a codec whose encode is a bug
            throw new RangeError("Unencodable date");
          },
        }),
      }),
    );

    // WHEN it is called
    const called = await contractCall(renew, { due: "2026-11-01" }, (validated) =>
      OkAsync(validated),
    );

    // THEN the codec's bug is a defect
    expect(called).toBeDefectWith(new RangeError("Unencodable date"));
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

  it("decodes a procedure's answer", async () => {
    // GIVEN a page count travelling as text
    const Pages = z.coerce.bigint();

    // WHEN an answer is decoded
    const decoded = await contractOutput(Pages, "120");

    // THEN the field resolves the decoded value
    expect(decoded).toBeOkWith(120n);
  });

  it("answers a defect for an answer breaking its own contract", async () => {
    // GIVEN a page count travelling as text
    const Pages = z.coerce.bigint();

    // WHEN an answer that is no number is decoded
    const decoded = await contractOutput(Pages, "some");

    // THEN the service broke its contract
    expect(decoded).toBeDefect();
  });

  it("decodes an answer through an asynchronous transform", async () => {
    // GIVEN a page count resolved asynchronously
    const Pages = z.number().transform(async (pages) => Promise.resolve(pages * 2));

    // WHEN an answer is decoded
    const decoded = await contractOutput(Pages, 60);

    // THEN the field resolves the transformed value
    expect(decoded).toBeOkWith(120);
  });
});
