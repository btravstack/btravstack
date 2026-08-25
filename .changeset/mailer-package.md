---
"@btravstack/mailer": minor
---

A `Mailer` port, a recording adapter a spec asserts against, an SMTP adapter,
and one composition function that spans, counts and logs every send by
default — `instrumented: false` opts out.

`send` answers when the transport accepted the message, which is not delivery;
a failure comes back as a modeled `MailNotSent` carrying the envelope and the
transport's own words, **never the body**. Retries are deliberately absent:
what to do about a failed send belongs to the caller's transport, and
`examples/order-amqp-worker` answers a `RetryableError` so the broker's own
budget owns redelivery. `nodemailer` is the one optional peer, behind the
`@btravstack/mailer/smtp` subpath.
