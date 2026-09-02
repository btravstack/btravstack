# CLAUDE.md — @btravstack/mailer

The application-service port for sending mail: a `Mailer` an application
depends on, adapters that provide the `MailerBackend` behind it, and one
composition function that binds them together, with every send reported is
spanned, counted and logged.

The second of issue #62's three ports, on `@btravstack/cache`'s shape exactly
— read that package's `CLAUDE.md` for the two-port rationale and the
conditional return type; only what differs is written out here.

## Public surface

### `@btravstack/mailer` (root)

| Export                              | What it is                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Mailer`                            | The port an application depends on: `send(mail)`.                                                                 |
| `MailerBackend`                     | The port every adapter provides. Not for application code.                                                        |
| `MailerService`                     | The service both ports carry.                                                                                     |
| `Mail`                              | `{ from, to, subject, text, html? }`.                                                                             |
| `MailNotSent`                       | The modeled failure: `{ to, subject, reason }` — never the body.                                                  |
| `mailer({ adapter })`               | The composition: the adapter's module, plus the port provided from its backend, every call handed to `Observers`. |
| `MailerOptions`                     | `{ adapter: Module<MailerBackend, E, N> }`.                                                                       |
| `mailRecorder()`                    | `{ record, sent, only }` — the adapter's half and the test's, on one object.                                      |
| `recordingMailer(recorder)`         | The recording adapter as a module.                                                                                |
| `recordingMailerProvider(recorder)` | The same as a provider — what `overridden` takes.                                                                 |
| `recordingMailerBackend(recorder)`  | The service itself, for a spec that wants no graph.                                                               |

### `@btravstack/mailer/smtp`

| Export                         | What it is                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `smtpMailer()`                 | The SMTP adapter: `SMTP_URL` through `Config`, one pooled transport on the scope. |
| `smtpMailerBackend(transport)` | The service over a `nodemailer` transport.                                        |
| `MailerConfig`                 | The port the URL is bound onto.                                                   |
| `smtpSchema`                   | The `Config.object` behind it — one required `SMTP_URL`.                          |

`nodemailer` is the package's one **optional** peer, reached only through this
subpath.

What the observers make of a send:

| Signal  | Name                                                               | Attributes                                                                                       |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| span    | `mail.send`                                                        | `btravstack.mail.recipients` (a **count**), `btravstack.mail.subject`; error status on a failure |
| counter | `btravstack.mail.operations`                                       | `{ operation, outcome }` — `send`, and `ok` or `error`                                           |
| log     | `"mail sent"` at `info`, `"the mail could not be sent"` at `error` | `{ recipients, subject }`, with the failure as the cause                                         |

## Decisions

- **The envelope rides the signals; the body never does, and neither do the
  addresses.** `to` is recorded as a _count_, because a recipient list is
  personal data and a span is not the place for it, while the subject is what
  an operator recognises a stuck mail by. `instrument.spec.ts` asserts the
  body text is absent from the span's attributes rather than trusting the
  code to keep being careful.
- **`send` means accepted, not delivered.** Nothing this side of a mailbox can
  promise delivery; an application that needs those semantics reads its
  provider's webhooks.
- **Retries are not here.** A failed send is a modeled `MailNotSent`, and what
  to do about it belongs to the caller's transport — `order-amqp-worker`
  answers a `RetryableError`, so the broker's own budget owns redelivery
  rather than a policy invented inside a port.
- **The recording adapter cannot fail.** A spec that needs the failure arm
  composes an adapter of its own; a configurable failure mode would put a
  policy in a fixture whose whole value is having none.
- **`text` is required, `html` optional.** A mail with only HTML is a mail
  some clients cannot read.
- **The transport is a private port.** A resourceful provider is handed back
  the service it acquired, and one `send` method is not something you can
  close — so the transporter rides the graph and the scope closing is what
  closes its pool.

## Deliberately not here

- **No templating.** A subject and two bodies; rendering belongs to a library
  an application chooses.
- **No attachments, no cc/bcc, no custom headers.** Each is a decision a
  provider's own options already model better than a port could.
- **No bulk send and no queue.** Sending many is the caller's loop, and
  scheduling one is `@btravstack/temporal-worker`'s job — the transport role map is
  a decision, not an inventory (root `CLAUDE.md`, thesis #1).
- **No address validation.** The transport rejects what it will not take, and
  a second opinion in a port would be a different, worse one.

## Testing

`packages/mailer` needs a **Docker daemon**: its SMTP specs run against the
shared `axllent/mailpit:v1.31.0` in `internal/test-infra` and read the
delivered message back through Mailpit's API. Isolation is a **recipient per
test** — a UUID localpart — so nothing is purged and one suite cannot read
another's mail.

Mailpit is a catch-all by design: it accepts even an empty sender, which makes
it a good fixture for the success path and a useless one for the failure path.
The `MailNotSent` arm is therefore proved against a relay that is **not
listening** (`smtp://127.0.0.1:1`), which is the failure a deployment actually
meets and costs milliseconds.

Coverage is 100% lines/functions, `test-fixtures.ts` excluded.
`src/module.test-d.ts` pins the needs gate and all five flag arms, including
that a runtime-computed boolean lands on the side that owes the three ports.

## Observation is a set port, not a flag

Every call this package makes observable is handed to whatever contributed to
`Observers` — `@btravstack/core`'s set port — and this module contributes a
**no-op member of its own**, so a graph composing no observability owes nothing,
installs nothing — an operation costs one inert call per module that reads the port.

`instrumented` is gone. It defaulted to `true` and therefore put `Logger`,
`Meter` and `Tracer` in this module's `Needs`, so a root that wanted a cache and
no OpenTelemetry SDK got a compile error naming three ports and had to find an
option to turn something off it never asked for. A set port has the property the
flag was reaching for and the flag could not have: **on when observability is
composed, free when it is not, and one composition either way.**

**A reader of the port must contribute a member**, the way `otel()` does for
`Instrumentations`: a collector depending on a set port nothing provides is an
unmet dependency, at plan time and in `Needs` alike. Several no-ops in one graph
cost a call each.

**Dimensions and details are separate, and that split is what lets one observer
serve every component.** `attributes` are bounded and ride the instruments;
`details` are unbounded — a cache key, a mail subject, a URL — and ride the span
and the error line only. Without it every contributor would have to choose
between a useful span and a safe metric.

What the observers do with an operation belongs to `@btravstack/observability`:
`observability()` writes a line when one FAILS (never on success — that is what
the metric is for), and `otel()` opens the span and mints
`btravstack.<component>.operations` and `btravstack.<component>.duration`. The
names are derived from the operation's own `component`, so nothing had to become
uniform to be shared.
