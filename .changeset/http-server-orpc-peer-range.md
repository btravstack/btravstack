---
"@btravstack/http-server": patch
"@btravstack/mailer": patch
---

Two peer ranges now name the version each package is built and tested
against.

- `@btravstack/http-server`: `@unthrown/orpc` is `^0.2.0`. It said `^0.1.0`,
  which on a `0.x` line excludes 0.2.0, so a consumer installing both under
  `strictPeerDependencies` was refused.
- `@btravstack/mailer`: `nodemailer` is `^10.0.6`. It said `^9.0.0`, which
  excluded the 10.x line the package runs on and admitted the releases
  GHSA-v53p-9fqp-m79j and GHSA-prgh-xp8r-p3m5 cover. An application still on
  nodemailer 9 must move to 10.0.6 or later.
