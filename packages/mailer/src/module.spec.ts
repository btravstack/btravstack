import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { aMail, it } from "./__tests__/test-fixtures.js";
import { Mailer } from "./mailer.js";
import { mailer } from "./module.js";
import { mailRecorder, recordingMailer } from "./recording.js";

describe("mailer", () => {
  it("provides Mailer from the adapter's backend when instrumentation is off", async () => {
    // GIVEN a graph composing the recording adapter, opted out of
    // instrumentation — the only arm that needs no observability
    const recorder = mailRecorder();
    const root = Module("Root")({
      imports: [mailer({ adapter: recordingMailer(recorder) })],
      exports: [Mailer],
    });

    // WHEN Mailer is resolved and driven
    const sent = await Module.scoped(root, (ctx) =>
      ctx.get(Mailer).send(aMail("ada@example.test")),
    );

    // THEN the port answered, and the adapter behind it is the one composed
    expect({ sent, recorded: recorder.sent().length }).toEqual({
      sent: expect.objectContaining({ tag: "Ok" }),
      recorded: 1,
    });
  });
});
