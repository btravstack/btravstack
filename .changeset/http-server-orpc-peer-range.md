---
"@btravstack/http-server": minor
"@btravstack/mailer": minor
---

Peer ranges now name versions each package can actually be installed and tested with. Both bumps are `minor` because they narrow a peer: on `0.x`, a patch would land inside consumers' `^0.16.0` ranges and fail a strict-peer install they never opted into.

- `@btravstack/http-server`:
  - `@unthrown/orpc` is `^0.2.0`. It said `^0.1.0`, which on a `0.x` line excludes the 0.2.0 this package is built against, so a consumer installing both under `strictPeerDependencies` was refused.
  - `unthrown` is `^5.7.0`. It said `^5.0.0`, but `@unthrown/orpc@0.2.0` itself requires `unthrown ^5.7.0`, so every `unthrown` 5.0–5.6 the old range admitted could not be installed beside it.
- `@btravstack/mailer`: `nodemailer` is `^10.0.14`. It said `^9.0.0`, which excluded the 10.x line the package runs on and admitted the releases GHSA-v53p-9fqp-m79j and GHSA-prgh-xp8r-p3m5 cover. 10.0.14 is the release this is built and tested against; 10.0.6 through 10.0.14 each fix a linear-time parsing or SMTP denial-of-service issue. An application on an earlier nodemailer must move to 10.0.14 or later.
