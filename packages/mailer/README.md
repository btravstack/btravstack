# @btravstack/mailer

> The mail port for [`@btravstack/core`](../core): one `Mailer` an application
> depends on, a recording adapter a spec asserts against, an SMTP adapter, and
> a span, a count and a log line per send.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/mailer)** ·
[API Reference](https://btravstack.github.io/btravstack/api/mailer/)

```sh
pnpm add @btravstack/mailer @btravstack/core @btravstack/config @btravstack/di unthrown
```

Four peer dependencies, plus `nodemailer` — optional, and needed only if you
compose the SMTP adapter. Instrumentation needs no peer of its own: the
`Logger`, `Tracer` and `Meter` it depends on are
[the kernel's ports](https://btravstack.github.io/btravstack/reference/core/observability).
Node `>=22`.

## A worked example

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import { Module } from "@btravstack/di";
import { Logger } from "@btravstack/core";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { RetryableError } from "@amqp-contract/worker";
import { P } from "unthrown";
-->

A notification, and the failure arm that makes it honest:

```ts
import { Mailer } from "@btravstack/mailer";
import { Port, Provider } from "@btravstack/di";
import type { AsyncResult } from "unthrown";

class Notifier extends Port("ReadmeNotifier")<{
  readonly placed: (
    to: string,
    orderId: string,
  ) => AsyncResult<void, RetryableError>;
}> {}

export const notifier = Provider(Notifier)({
  inject: { mailer: Mailer },
  sync: ({ mailer }) => ({
    placed: (to, orderId) =>
      mailer
        .send({
          from: "orders@example.test",
          to: [to],
          subject: `order ${orderId} placed`,
          text: `Order ${orderId} is on its way.`,
        })
        // A failed send is YOUR transport's problem, which is why the port
        // models it instead of retrying: leaving the delivery un-acked
        // hands it to the next worker, on the broker's own budget.
        .mapErrCases((matcher) =>
          matcher.with(
            P.tag("MailNotSent"),
            (error) =>
              new RetryableError(
                `order ${orderId} was not notified: ${error.reason}`,
              ),
          ),
        ),
  }),
});
```

The composition — the adapter, and whether sends are instrumented, decided
here and nowhere else:

```ts
import { mailer } from "@btravstack/mailer";
import { smtpMailer } from "@btravstack/mailer/smtp";

export const NotifierApp = Module("NotifierApp")({
  imports: [
    // Instrumented by default: a span, a counter and a log line per send,
    // which is why `observability()` and `otel()` are below. Pass
    // `instrumented: false` for the same graph without them.
    mailer({ adapter: smtpMailer() }),
    observability(),
    otel(),
  ],
  provides: [notifier],
  exports: [Notifier, Logger],
});
```

And in a test, the adapter that sends nothing and keeps everything:

<!-- doctest: skip — the assertion belongs to a spec, and the gate runs the real one in examples/order-amqp-worker -->

```ts
const recorder = mailRecorder();
const app = overridden(NotifierApp, [recordingMailerProvider(recorder)]);
// … place an order through the real graph …
expect(recorder.only()).toEqual(
  expect.objectContaining({ subject: "order 42 placed" }),
);
```

## Options

| Option         | Where                               | What it is                                                                              |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| `adapter`      | `mailer({ adapter })`               | the adapter module providing `MailerBackend` — required                                 |
| `instrumented` | `mailer({ instrumented })`          | span, count and log every send (default `true`; `false` opts out and declares no ports) |
| `SMTP_URL`     | environment, read by `smtpMailer()` | the transport URL — required, validated at graph build                                  |

The full table — defaults, semantics and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/mailer),
which is this list's one detailed home.

## What it decides, and what it does not

**It decides** that a send is _accepted_, not delivered; that a failure is a
modeled `MailNotSent` carrying the envelope and never the body; and that
sends are instrumented unless you say otherwise.

**It does not decide** what happens after a failure — retrying belongs to your
transport, and the example answers a `RetryableError` so the broker's budget
owns it. There is no templating, no attachments, no bulk send and no address
validation; the reasons are in [`CLAUDE.md`](./CLAUDE.md).
