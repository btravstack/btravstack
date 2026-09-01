---
title: "@btravstack/mailer"
description: The complete surface of @btravstack/mailer — the Mailer and MailerBackend ports, Mail, MailNotSent, the recording and SMTP adapters, mailer(), the Observers seam it reports through, and SMTP_URL.
---

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import { Logger } from "@btravstack/core";
import { Mailer, MailerBackend, mailer, mailRecorder, recordingMailer, recordingMailerProvider, type MailerService } from "@btravstack/mailer";
import { smtpMailer } from "@btravstack/mailer/smtp";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { overridden } from "@btravstack/testing";
import { P, type AsyncResult } from "unthrown";
import { RetryableError } from "@amqp-contract/worker";

declare const RealApp: Module<Mailer, never, never>;
-->

# @btravstack/mailer

> **Reference.** A complete, structured description of `@btravstack/mailer`:
> the `Mailer` port an application depends on, the `MailerBackend` every
> adapter provides, the modeled `MailNotSent`, the recording and SMTP
> adapters, and the one composition function that decides whether sends are
> instrumented.

## The port

```ts
export const notify = Provider(
  Port("ReferenceNotifier")<{
    readonly placed: (
      to: string,
      orderId: string,
    ) => ReturnType<MailerService["send"]>;
  }>,
)({
  inject: { mailer: Mailer },
  sync: ({ mailer }) => ({
    placed: (to, orderId) =>
      mailer.send({
        from: "orders@example.test",
        to: [to],
        subject: `order ${orderId} placed`,
        text: `Order ${orderId} is on its way.`,
      }),
  }),
});
```

`Mail` is deliberately small — `{ from, to, subject, text, html? }` — and
`text` is required: a mail with only HTML is a mail some clients cannot read.
There is no templating, no attachments and no custom headers, because each is
a decision a provider's own options model better than a port could.

**`send` answers when the transport accepted the message**, which is not the
same as delivered. Nothing this side of a mailbox can promise that; an
application needing those semantics reads its provider's webhooks.

## `MailNotSent`, and who retries

```ts
export const notifyOrRetry = (
  send: MailerService["send"],
  orderId: string,
): AsyncResult<void, RetryableError> =>
  send({
    from: "orders@example.test",
    to: ["someone@example.test"],
    subject: `order ${orderId} placed`,
    text: "…",
  }).mapErrCases((matcher) =>
    matcher.with(
      P.tag("MailNotSent"),
      (error) =>
        new RetryableError(
          `order ${orderId} was not notified: ${error.reason}`,
        ),
    ),
  );
```

`MailNotSent` carries `{ to, subject, reason }` — the envelope and the
transport's own words, **never the body**, which is the one part of a message
that is reliably somebody's personal data.

**Retries are not in this package, and that is the decision.** What to do
about a failed send depends on what is sending: `examples/order-amqp-worker`
turns it into a `RetryableError`, so the delivery stays un-acked and the
broker's own retry budget owns redelivery — a policy that already exists,
tuned per queue, instead of a second one invented inside a port.

## Adapters

### `recordingMailer(recorder)`

The testable-by-default half, and usually the one that matters: the question
in a test is almost never "did SMTP work", it is "would this code have sent
the right message".

```ts
export const recorded = () => {
  const recorder = mailRecorder();
  return {
    app: overridden(RealApp, [recordingMailerProvider(recorder)]),
    recorder,
  };
};
```

`mailRecorder()` returns `{ record, sent, only }` — the adapter's half and the
test's on one object, so nothing reaches into an array somebody else owns.
`only()` throws unless there is exactly one mail: a spec that asserted on the
wrong message would otherwise pass while proving nothing.

It **cannot fail**. A spec that needs the failure arm composes an adapter of
its own; a configurable failure mode would put a policy in a fixture whose
whole value is having none.

### `smtpMailer()`

One pooled transport, opened with the scope and closed with it.

| Variable   | Required | Default | What it is                                                            |
| ---------- | -------- | ------- | --------------------------------------------------------------------- |
| `SMTP_URL` | yes      | none    | the transport URL, read through `Config` and validated at graph build |

One URL rather than a host/port/user/password quartet: it is what `nodemailer`
takes, what a provider hands you, and what a deployment already stores as one
secret. Unset or blank is a `ConfigInvalid` naming it — exit `78` under
`runMain`, before a mail is attempted.

`nodemailer` is an **optional** peer, reached only through the
`@btravstack/mailer/smtp` subpath.

## `mailer({ adapter })`

One function, and the adapter is the only decision at it. Sends are reported
at the composition root.

```ts
export const NotifierApp = Module("ReferenceNotifierApp")({
  imports: [mailer({ adapter: smtpMailer() }), observability(), otel()],
  provides: [notify],
  exports: [Mailer, Logger],
});
```

| Signal  | Name                                                               | Attributes                                                                                   |
| ------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| span    | `mail.send`                                                        | `btravstack.mail.recipients` (a count), `btravstack.mail.subject`; error status on a failure |
| counter | `btravstack.mail.operations`                                       | `{ operation, outcome }` — `send`, and `ok` or `error`                                       |
| log     | `"mail sent"` at `info`; `"the mail could not be sent"` at `error` | `{ recipients, subject }`, with the failure as the cause                                     |

**The envelope rides the signals; the addresses and the body do not.** `to`
becomes a _count_, because a recipient list is personal data and a span is not
the place for it, while the subject is what an operator recognises a stuck
mail by. The package's own spec asserts the body text is absent from the
span's attributes rather than trusting the code to keep being careful.

**Observation is a set port, not a flag.** Every call is handed to whatever
contributed to `Observers`, and this module contributes a no-op member of its
own — so a graph composing no observability owes nothing, installs nothing and
costs one call per operation. Composing
[`observability()`](/reference/observability) writes the failures as lines;
composing `otel()` beside it opens the spans and mints the instruments. Neither
changes a line of this composition.

## What it deliberately does not do

- **No templating, no attachments, no cc/bcc, no custom headers.**
- **No bulk send and no scheduling.** Sending many is your loop; scheduling
  one is [`@btravstack/temporal-worker`](/reference/temporal-worker)'s job.
- **No address validation.** The transport rejects what it will not take, and
  a second opinion in a port would be a different, worse one.
- **No delivery tracking.** `send` means accepted.
