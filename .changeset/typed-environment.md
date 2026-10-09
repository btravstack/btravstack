---
"@btravstack/config": minor
"@btravstack/core": minor
"@btravstack/testing": minor
"@btravstack/http-server": minor
"@btravstack/orpc-server": minor
"@btravstack/amqp-worker": minor
"@btravstack/temporal-worker": minor
"@btravstack/cache": minor
"@btravstack/mailer": minor
"@btravstack/storage": minor
"@btravstack/outbox": minor
"@btravstack/observability": minor
---

The environment variables a graph reads are in its type. A `Config` field names its variable and whether it must be set; `Config.provider` (and the new `Config.env`) put the names in the provider's needs as `EnvReading<Required, Optional>`; every starter's module type names what it reads. `start`, `runMain` and `@btravstack/testing`'s `boot` type their `env` by it, with the kernel's own variables: a required variable must be present, and a misspelt or unread one is a compile error. `StartEnvironment<typeof Root>` types an environment kept apart from the call. A reader that names nothing — `Env` injected whole, a hand-written `ConfigField<T>` — keeps the environment open, as before. A variable a starter option can pin is optional in the type.
