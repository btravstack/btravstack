# CLAUDE.md — @btravstack/mailer

The application-service port for sending mail: a `Mailer` an application
depends on, adapters that provide the `MailerBackend` behind it, and one
composition function that binds them together, with every send reported is
spanned, counted and logged.

The second of issue #62's three ports, on `@btravstack/cache`'s shape exactly
— read that package's `CLAUDE.md` for the two-port rationale and the
conditional return type; only what differs is written out here.

## Public surface

The exports are `src/index.ts` and `src/smtp.ts` (`@btravstack/mailer/smtp`),
each with its TSDoc; what the observers make of a send is `src/instrument.ts`,
and `docs/reference/mailer.md` is the reader's page.

## Decisions

The envelope rule, `send` meaning accepted, the recording adapter that cannot
fail and the private transport port are the TSDoc of `src/instrument.ts`,
`src/mailer.ts`, `src/recording.ts` and `src/smtp.ts`.

- **Retries are not here.** A failed send is a modeled `MailNotSent`, and what
  to do about it belongs to the caller's transport — `order-amqp-worker`
  answers a `RetryableError`, so the broker's own budget owns redelivery
  rather than a policy invented inside a port.
- **`text` is required, `html` optional.** A mail with only HTML is a mail
  some clients cannot read.

## Health check

`smtpMailer()` contributes one `HealthChecks` member, named `mailer`, so the
kernel's `GET /healthz` reports on the relay without the application wiring
anything. The probe is nodemailer's `verify()` — a connection and an
authentication.

**What it proves is half a send, and that is the honest half.** `verify()`
reaches the relay and authenticates; whether a message is _delivered_ is the
provider's answer, days later, through webhooks the port deliberately does not
model (`send` means accepted). A probe cannot speak for that, so it does not
try.

## Deliberately not here

- **No templating, no i18n, and no attachment by path or stream** — `Mail`'s
  and `MailAttachment`'s TSDoc in `src/mailer.ts` says why.
- **No bulk send and no queue.** Sending many is the caller's loop, and
  scheduling one is `@btravstack/temporal-worker`'s job — the transport role map is
  a decision, not an inventory (root `CLAUDE.md`, thesis #1).
- **No address validation.** The transport rejects what it will not take, and
  a second opinion in a port would be a different, worse one.

## Testing

Mailpit is a catch-all by design: it accepts even an empty sender, which makes
it a good fixture for the success path and a useless one for the failure path.
The `MailNotSent` arm is therefore proved against a relay that is **not
listening** (`smtp://127.0.0.1:1`), which is the failure a deployment actually
meets and costs milliseconds.

Observation: see the root `CLAUDE.md`, **Observability is a set port, never a flag**.
