---
"@btravstack/amqp-worker": minor
"@btravstack/temporal-worker": minor
"@btravstack/http-server": minor
---

Peer ranges now start at a version that installs. The consumer check installs each package alone with its required peers at the lowest version each range admits, and three ranges admitted releases that could not be installed or loaded:

- `@btravstack/amqp-worker` and `@btravstack/temporal-worker`: `unthrown` is `^5.7.0`. It said `^5.0.0`, but `@amqp-contract/worker` and `@temporal-contract/worker` depend on `@unthrown/standard-schema` and `@unthrown/saga`, which require `unthrown ^5.7.0`, so a strict-peer install of any 5.0–5.6 was refused.
- `@btravstack/http-server`: the `@orpc/*` peers are `^2.0.0-beta.28`. They said `^2.0.0-beta`, which admitted betas without the `@orpc/server/plugins` export the package imports, so it did not load. 2.0.0-beta.28 is the beta it is built and tested against.

These narrow peer ranges, so they ship as `minor`: on 0.x, a patch would land inside consumers' `^0.x` ranges and fail a strict-peer install.
