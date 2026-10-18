import { createTransport } from "nodemailer";
import { describe, expect, it } from "vitest";

import { smtpMailerBackend } from "./smtp.js";

describe("smtpMailerBackend", () => {
  it("keeps the transport's rejected recipients when every RCPT is refused", async () => {
    // GIVEN nodemailer's all-recipients-rejected error, including a parsed CC and BCC envelope
    const rejected = ["to@example.test", "cc@example.test", "bcc@example.test"];
    const transport = createTransport({
      name: "refusing-relay",
      version: "1",
      send: (_mail, callback) =>
        callback(
          Object.assign(new Error("Can't send mail - all recipients were rejected: 550 refused"), {
            code: "EENVELOPE",
            command: "RCPT TO",
            responseCode: 550,
            rejected,
          }),
        ),
    });

    // WHEN the SMTP backend receives that failure
    const sent = await smtpMailerBackend(transport).send({
      from: "sender@example.test",
      to: ["Recipient <to@example.test>"],
      cc: ["cc@example.test"],
      bcc: ["bcc@example.test"],
      subject: "retry",
      text: "body",
    });

    // THEN it preserves the transport's parsed rejected addresses
    expect(sent).toBeErrWith(expect.objectContaining({ to: rejected }));
  });
});
