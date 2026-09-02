import { describe, expect } from "vitest";
import { vi } from "vitest";

import { aMail, it } from "./__tests__/test-fixtures.js";

describe("smtpMailer", () => {
  it("delivers the message to the server", async ({ smtp, recipient, delivered }) => {
    // GIVEN a mailer over the shared SMTP server
    // WHEN a message is sent to this test's own recipient
    await smtp.send(aMail(recipient));

    // THEN the server received it, addressed and titled as sent — waiting on
    // the mailbox rather than asserting through it, so the one expect is the
    // assertion and not the barrier
    await vi.waitUntil(async () => (await delivered(recipient)).length === 1);
    expect((await delivered(recipient))[0]).toEqual(
      expect.objectContaining({
        To: [expect.objectContaining({ Address: recipient })],
        Subject: "your order",
      }),
    );
  });

  it("delivers an html body beside the text one", async ({ smtp, recipient, delivered }) => {
    // GIVEN a message carrying both bodies — the optional half of `Mail`
    // WHEN it is sent
    await smtp.send({ ...aMail(recipient), html: "<p>thank you</p>" });

    // THEN the server received one message for this recipient: the html arm
    // rides the same envelope rather than a second send
    await vi.waitUntil(async () => (await delivered(recipient)).length === 1);
    expect((await delivered(recipient))[0]).toEqual(
      expect.objectContaining({ Subject: "your order" }),
    );
  });

  it("delivers the rest of the envelope: a cc, an attachment and an extra header", async ({
    smtp,
    recipient,
    delivered,
    headersOf,
  }) => {
    // GIVEN a message carrying everything beyond the required envelope
    const copied = `cc-${recipient}`;

    // WHEN it is sent
    await smtp.send({
      ...aMail(recipient),
      cc: [copied],
      attachments: [{ filename: "invoice.txt", content: "total: 42" }],
      headers: { "X-Order-Id": "o-1" },
    });

    // THEN the server received all three, rather than an envelope the adapter
    // quietly dropped on its way to `sendMail`
    await vi.waitUntil(async () => (await delivered(recipient)).length === 1);
    const [message] = await delivered(recipient);
    expect({
      cc: message?.Cc,
      attachments: message?.Attachments,
      header: (await headersOf(message?.ID ?? ""))["X-Order-Id"],
    }).toEqual({
      cc: [expect.objectContaining({ Address: copied })],
      attachments: 1,
      header: ["o-1"],
    });
  });

  it("answers MailNotSent when the relay is unreachable", async ({ unreachable, recipient }) => {
    // GIVEN a mailer over a relay that is not listening
    // WHEN a message is sent
    const sent = unreachable.send(aMail(recipient));

    // THEN the failure is modeled, carrying the envelope and the transport's
    // own words — and never the body
    await expect(sent).toBeErrWith(
      expect.objectContaining({
        to: [recipient],
        subject: "your order",
        reason: expect.any(String),
      }),
    );
  });
});
