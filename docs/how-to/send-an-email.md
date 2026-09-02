---
title: Send an email
description: "Compose the mailer starter, send from a use case, decide what a failed send means for your transport, and assert on what would have been sent."
---

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import { Mailer, mailer, mailRecorder, recordingMailer, recordingMailerProvider } from "@btravstack/mailer";
import { observability } from "@btravstack/observability";
import { smtpMailer } from "@btravstack/mailer/smtp";
import { Logger } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { RetryableError } from "@amqp-contract/worker";
import { P, type AsyncResult } from "unthrown";
import { overridden } from "@btravstack/testing";

type Order = { readonly id: string; readonly customerEmail: string };
declare const AppModule: Module<never, never, never>;
-->

# Send an email

> **How-to.** Get transactional mail out of an application, with the failure on
> a channel your transport can act on. For the port's surface, see
> [`@btravstack/mailer`](/reference/mailer).

## 1. Send from a use case

**`send` answers when the transport ACCEPTED the message**, which is not the
same as delivered. Nothing this side of a mailbox can promise delivery; an
application that needs those semantics reads its provider's webhooks.

```ts
class Notifier extends Port("Notifier")<{
  readonly placed: (order: Order) => AsyncResult<void, RetryableError>;
}> {}

export const notifier = Provider(Notifier)({
  inject: { mailer: Mailer },
  sync: ({ mailer }) => ({
    placed: (order) =>
      mailer
        .send({
          from: "orders@example.test",
          to: [order.customerEmail],
          subject: `Order ${order.id} placed`,
          // `text` is required: a mail with only HTML is a mail some clients
          // cannot read.
          text: `Order ${order.id} is on its way.`,
          html: `<p>Order <strong>${order.id}</strong> is on its way.</p>`,
        })
        .mapErrCases((matcher) =>
          matcher.with(
            P.tag("MailNotSent"),
            (error) => new RetryableError(`order ${order.id} was not notified: ${error.reason}`),
          ),
        ),
  }),
});
```

## 2. Compose the starter

```ts
export const NotifierApp = Module("NotifierApp")({
  imports: [AppModule, mailer({ adapter: smtpMailer() }), observability()],
  provides: [notifier],
  exports: [Notifier, Logger],
});
```

`smtpMailer()` binds `SMTP_URL` through `Config` — one URL rather than a
host/port/user/password quartet, because that is what the transport takes and
what a deployment already stores as one secret — and holds one pooled transport
as a resource of the graph, closed when the scope closes. It also contributes a
health check (`verify()`, a connection and an authentication) that the kernel
folds into `/healthz`.

`nodemailer` is an **optional peer**, reached only through the
`@btravstack/mailer/smtp` subpath: an application that composes the recording
adapter never installs it.

## 3. Decide what a failure means — the port will not

`MailNotSent` carries `{ to, subject, reason }` and **never the body**, since a
body is the one part of a message that is reliably somebody's personal data.
There is no retry inside the port, deliberately: what to do about a failed send
belongs to the caller's transport, whose retry budget already exists.

The mapping above is the AMQP answer — a `RetryableError` leaves the delivery
un-acked, so the broker hands it to the next worker on its own budget. Under
Temporal it would be an ordinary activity failure and the platform's retry
policy; under HTTP it is a decision about the response, and usually a sign the
send should not have been in the request path at all.

## The whole envelope, when you need it

```ts
export const invoiceMail = (order: Order, pdf: Uint8Array) => ({
  from: "billing@example.test",
  to: [order.customerEmail],
  cc: ["accounts@example.test"],
  bcc: ["archive@example.test"],
  subject: `Invoice for order ${order.id}`,
  text: "Your invoice is attached.",
  attachments: [
    { filename: `invoice-${order.id}.pdf`, content: pdf, contentType: "application/pdf" },
  ],
  headers: { "X-Order-Id": order.id },
});
```

An attachment is **bytes or a string**, never a path or a stream: a caller that
has a file can read it, and neither the port nor an adapter should have to own
a filesystem and a lifetime. Templating is not here — `text` and `html` are
strings, and what rendered them is a library you chose.

## 4. Assert on what would have been sent

The recording adapter sends nothing and keeps everything, which is what a test
usually wants: the question is rarely "does SMTP work" but "would this code
have sent the right message".

```ts
export const recorder = mailRecorder();
export const TestNotifier = overridden(NotifierApp, [recordingMailerProvider(recorder)]);
// … run the use case through the real graph, then:
// expect(recorder.only()).toEqual(expect.objectContaining({ subject: "Order 42 placed" }));
```

`recordingMailer(recorder)` is the same adapter as a module, for a root that
composes it directly rather than overriding one. It **cannot fail**: a spec
that needs the failure arm composes an adapter of its own, since a configurable
failure mode would put a policy in a fixture whose whole value is having none.

## Where to go next

- The port's surface: [`@btravstack/mailer`](/reference/mailer).
- Where a notification usually belongs — reacting to a committed fact:
  [Consume AMQP messages](/how-to/consume-amqp-messages).
- Swapping adapters under the real root:
  [Swap an adapter for tests](/how-to/swap-an-adapter).
