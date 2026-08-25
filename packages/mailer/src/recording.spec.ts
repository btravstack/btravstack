import { describe, expect } from "vitest";

import { aMail, it } from "./test-fixtures.js";

describe("recordingMailer", () => {
  it("keeps the message it was asked to send", async ({ recording, recorder }) => {
    // GIVEN a mailer that records rather than sends
    // WHEN a message is sent through it
    await recording.send(aMail("ada@example.test"));

    // THEN the one recorded mail is the one the caller built
    expect(recorder.only()).toEqual({
      from: "orders@example.test",
      to: ["ada@example.test"],
      subject: "your order",
      text: "thank you",
    });
  });

  it("answers Ok, because recording cannot fail", async ({ recording }) => {
    // GIVEN a recording mailer
    // WHEN a message is sent
    const sent = recording.send(aMail("ada@example.test"));

    // THEN the send succeeded — a fixture with a failure mode would be a
    // fixture with a policy
    await expect(sent).toBeOk();
  });

  it("refuses to answer only() when there is not exactly one mail", async ({
    recording,
    recorder,
  }) => {
    // GIVEN two messages sent through one recorder
    await recording.send(aMail("first@example.test"));
    await recording.send(aMail("second@example.test"));

    // WHEN the spec asks for "the" mail
    // THEN it fails loudly rather than silently picking one — a test that
    // asserted on the wrong message would pass while proving nothing
    expect(() => recorder.only()).toThrow("expected exactly one mail, got 2");
  });

  it("keeps every message, in order", async ({ recording, recorder }) => {
    // GIVEN two messages sent through one recorder
    await recording.send(aMail("first@example.test"));
    await recording.send(aMail("second@example.test"));

    // WHEN the record is read
    const recipients = recorder.sent().map((mail) => mail.to[0]);

    // THEN both are there, in the order they were sent
    expect(recipients).toEqual(["first@example.test", "second@example.test"]);
  });
});
