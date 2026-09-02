---
"@btravstack/mailer": minor
---

`smtpMailer()` contributes a health check.

`@btravstack/mailer` was the only application-service port with no
`HealthChecks` contribution and no stated reason, so a deployment composing it
got `/healthz` reporting on its cache and its database and silently nothing
about its relay.

The probe is nodemailer's `verify()` — a connection and an authentication —
named `mailer`, and the kernel folds it in with nothing wired at the
composition root.

**It lives on the adapter rather than on `mailer({ adapter })`**, which is the
difference from `@btravstack/cache`: there the probe is a `get` every backend
answers, so it belongs to the composition. Here the recording adapter sends
nowhere and would report healthy for free — a probe that proves nothing is
worse than no probe, because an operator reads it as coverage.

What it proves is half a send, and that is the honest half: whether a message
is _delivered_ is the provider's answer later, through webhooks this port does
not model.
