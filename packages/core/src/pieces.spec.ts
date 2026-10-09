import { Module, Port, Provider, type Context } from "@btravstack/di";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { composeByPrefix, mintPiece } from "./pieces.js";

describe("mintPiece and composeByPrefix", () => {
  it("mints a provider whose service is what sync answers, wrapped with the declared record", async () => {
    // GIVEN a piece injecting a greeting and declaring one unit-scoped port
    class Greeting extends Port("PiecesGreeting")<string> {}
    class Piece extends Port("Piece:greet")<unknown> {}
    const piece = mintPiece(Piece, (record, entry) => ({ declared: Object.keys(record), entry }))({
      inject: { greeting: Greeting },
      unit: { tenant: Greeting },
      sync: (({ greeting }: { readonly greeting: string }) => `${greeting}!`) as never,
    });

    // WHEN the graph holding it is built
    const built = Module.build(
      Module("PiecesMint")({
        provides: [Provider(Greeting)({ inject: {}, value: "hi" }), piece],
        exports: [Piece],
      } as never),
    );

    // THEN the piece's service is the wrapped answer, carrying the record it declared
    await expect(
      built.map((ctx) => (ctx as Context<InstanceType<typeof Piece>>).get(Piece)),
    ).toBeOkWith({ declared: ["tenant"], entry: "hi!" });
  });

  it("composes an array of pieces into one record keyed by each port id less the prefix", async () => {
    // GIVEN two pieces on prefixed ports, and the composed record's own port
    class Left extends Port("Piece:left")<string> {}
    class Right extends Port("Piece:right")<string> {}
    class Composed extends Port("PiecesComposed")<Readonly<Record<string, string>>> {}
    const left = Provider(Left)({ inject: {}, value: "L" });
    const right = Provider(Right)({ inject: {}, value: "R" });

    // WHEN the array arm composes them
    const composed = composeByPrefix(Composed, "Piece:", (_record, entry) => entry)([left, right]);
    const built = Module.build(
      Module("PiecesCompose")({ provides: [left, right, composed], exports: [Composed] } as never),
    );

    // THEN the services record is the composed record, keyed by contract key
    await expect(
      built.map((ctx) => (ctx as Context<InstanceType<typeof Composed>>).get(Composed)),
    ).toBeOkWith({ left: "L", right: "R" });
  });

  it("wraps every entry the record arm's sync answers", async () => {
    // GIVEN a record arm declaring neither deps nor a unit record
    class Composed extends Port("PiecesWhole")<Readonly<Record<string, string>>> {}

    // WHEN it is composed and built
    const composed = composeByPrefix(
      Composed,
      "Piece:",
      (record, entry) => `${String(entry)}+${Object.keys(record).length}`,
    )({ sync: () => ({ a: "x", b: "y" }) });
    const built = Module.build(
      Module("PiecesWhole")({ provides: [composed], exports: [Composed] } as never),
    );

    // THEN each entry was wrapped once, with the empty record
    await expect(
      built.map((ctx) => (ctx as Context<InstanceType<typeof Composed>>).get(Composed)),
    ).toBeOkWith({ a: "x+0", b: "y+0" });
  });
});
