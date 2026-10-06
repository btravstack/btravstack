---
"@btravstack/cache": minor
"@btravstack/mailer": minor
"@btravstack/storage": minor
---

**Breaking: the adapters' internals are no longer exported.** `redisCacheBackend`, `redisSchema` and `CacheConfig` from `@btravstack/cache/redis`, `smtpSchema` and `MailerConfig` from `@btravstack/mailer/smtp`, `recordingMailerBackend` from `@btravstack/mailer`, and `s3Schema` and `StorageConfig` from `@btravstack/storage/s3` had no user anywhere. Compose the adapter modules — `redisCache()`, `smtpMailer()`, `recordingMailer(recorder)` or `recordingMailerProvider(recorder)`, `s3Storage()` — as before.
