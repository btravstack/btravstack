import { describe, expect } from "vitest";

import { aMail, defectiveMailer, failingMailer, it } from "./__tests__/test-fixtures.js";
import { mailRecorder } from "./recording.js";
import { recordingMailer } from "./recording.js";

describe("mailer, observed", () => {
  it("opens one span per send, carrying the envelope and not the body", async ({
    instrumented,
  }) => {
    // GIVEN an instrumented mailer over a recording adapter
    // WHEN a message is sent
    await instrumented.run(recordingMailer(mailRecorder()), (service) =>
      service.send(aMail("ada@example.test")),
    );

    // THEN one span names the operation and carries a RECIPIENT COUNT and the
    // subject — never an address, and never the text
    expect(
      instrumented.spans().map((span) => ({
        name: span.name,
        recipients: span.attributes["btravstack.mail.recipients"],
        subject: span.attributes["btravstack.mail.subject"],
        leaked: JSON.stringify(span.attributes).includes("thank you"),
      })),
    ).toEqual([{ name: "mail.send", recipients: 1, subject: "your order", leaked: false }]);
  });

  it("counts a delivered message as ok", async ({ instrumented }) => {
    // GIVEN an instrumented mailer that accepts
    // WHEN a message is sent
    await instrumented.run(recordingMailer(mailRecorder()), (service) =>
      service.send(aMail("ada@example.test")),
    );

    // THEN the one counted point is an ok
    expect(
      instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    ).toEqual([{ operation: "send", outcome: "ok", value: 1 }]);
  });

  it("writes no line for a delivered message", async ({ instrumented }) => {
    // GIVEN an observed mailer that accepts
    // WHEN a message is sent
    await instrumented.run(recordingMailer(mailRecorder()), (service) =>
      service.send(aMail("ada@example.test")),
    );

    // THEN nothing is logged. A successful send is what the metric and the
    // span are for, and this package no longer holds a `Logger` to write a
    // line of its own — an application that wants an operator to see every
    // send writes that line where it sends
    expect(instrumented.lines()).toEqual([]);
  });

  it("counts and logs a relay that refused", async ({ instrumented }) => {
    // GIVEN an instrumented mailer whose adapter refuses
    // WHEN a message is sent
    await instrumented.run(failingMailer(), (service) => service.send(aMail("ada@example.test")));

    // THEN the failure is one error line and one counted error
    expect({
      lines: instrumented.lines().map((line) => ({ level: line.level, message: line.message })),
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    }).toEqual({
      lines: [{ level: "error", message: "mail.send failed" }],
      points: [{ operation: "send", outcome: "error", value: 1 }],
    });
  });

  it("hands the caller's own Result straight back", async ({ instrumented }) => {
    // GIVEN an instrumented mailer whose adapter refuses
    // WHEN a message is sent
    const sent = await instrumented.run(failingMailer(), (service) =>
      service.send(aMail("ada@example.test")),
    );

    // THEN the wrapper is transparent: the backend's error is what arrives
    expect(sent).toBeErrWith(
      expect.objectContaining({ to: ["ada@example.test"], reason: "the relay refused" }),
    );
  });
});

describe("mailer, observed, when the transport defects", () => {
  it("still ends the span and counts the send as an error", async ({ instrumented }) => {
    // GIVEN an instrumented mailer over a transport that throws — the shape
    // the port does not model, because it is a bug rather than an outcome
    // WHEN a message is sent
    await instrumented.run(defectiveMailer(), (service) => service.send(aMail("ada@example.test")));

    // THEN the send is counted an error, and the span it opened was ended
    expect({
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
      spans: instrumented.spans().map((span) => span.name),
    }).toEqual({
      points: [{ operation: "send", outcome: "error", value: 1 }],
      spans: ["mail.send"],
    });
  });
});
