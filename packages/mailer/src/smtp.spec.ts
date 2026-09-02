import { Env } from "@btravstack/config";
import { HealthChecks, runHealthChecks } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { describe, expect } from "vitest";
import { vi } from "vitest";
import { inject } from "vitest";

import { aMail, it } from "./__tests__/test-fixtures.js";
import { smtpMailer, verifyWithin } from "./smtp.js";

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

  it("delivers a cc and an attachment", async ({ smtp, recipient, delivered }) => {
    // GIVEN a message carrying the envelope beyond `to`
    const copied = `cc-${recipient}`;

    // WHEN it is sent
    await smtp.send({
      ...aMail(recipient),
      cc: [copied],
      attachments: [{ filename: "invoice.txt", content: "total: 42" }],
    });

    // THEN the server received both, rather than an envelope the adapter
    // quietly dropped on its way to `sendMail`
    await vi.waitUntil(async () => (await delivered(recipient)).length === 1);
    expect((await delivered(recipient))[0]).toEqual(
      expect.objectContaining({
        Cc: [expect.objectContaining({ Address: copied })],
        Attachments: 1,
      }),
    );
  });

  it("delivers an extra header", async ({ smtp, recipient, delivered, headersOf }) => {
    // GIVEN a message carrying a header the port does not name
    // WHEN it is sent
    await smtp.send({ ...aMail(recipient), headers: { "X-Order-Id": "o-1" } });

    // THEN the header is on the delivered message — the one place a
    // passthrough is visible, since the summary does not carry it
    await vi.waitUntil(async () => (await delivered(recipient)).length === 1);
    const [message] = await delivered(recipient);
    expect(await headersOf(message?.ID ?? "")).toEqual(
      expect.objectContaining({ "X-Order-Id": ["o-1"] }),
    );
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

  it("contributes a health check the kernel folds into /healthz", async () => {
    // GIVEN the adapter composed over the shared SMTP server
    const env = { SMTP_URL: inject("__TESTCONTAINERS_SMTP_URL__") };
    const root = Module("HealthFixture")({
      imports: [smtpMailer()],
      provides: [Provider(Env)({ inject: {}, value: env })],
      exports: [HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN the relay answered `verify()` — a connection and an authentication,
    // which is the half of a send provable without sending
    expect(report).toBeOkWith({
      status: "healthy",
      components: [{ name: "mailer", status: "healthy" }],
    });
  });

  it("reports the mailer unhealthy when the relay will not answer", async () => {
    // GIVEN the adapter pointed at a port nothing is listening on
    const root = Module("UnhealthyFixture")({
      imports: [smtpMailer()],
      provides: [Provider(Env)({ inject: {}, value: { SMTP_URL: "smtp://127.0.0.1:1" } })],
      exports: [HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN the component is named and unhealthy, carrying the transport's own
    // words, and the report is unhealthy with it — one failing component is
    // what makes the whole report say so
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [{ name: "mailer", status: "unhealthy", reason: expect.any(String) }],
    });
  });

  it("gives up on a relay that never answers, rather than holding the probe open", async () => {
    // GIVEN a transport whose `verify()` never settles — the shape a relay
    // that accepts the connection and never greets presents
    const hanging = {
      verify: () => new Promise<boolean>(() => {}),
    } as unknown as Parameters<typeof verifyWithin>[0];

    // WHEN the health check's own deadline passes
    const verified = verifyWithin(hanging, 5).then(
      () => "answered",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );

    // THEN it reports rather than waiting: `runHealthChecks` has no deadline
    // of its own, so a probe that hangs is one an orchestrator times out
    // instead of reading
    await expect(verified).resolves.toBe("the relay did not answer within 5 ms");
  });
});
