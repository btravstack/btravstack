---
"@btravstack/amqp-client": patch
"@btravstack/amqp-worker": patch
---

Bound start-up against a broker that accepts TCP but never answers the AMQP
handshake. The `@amqp-contract/client` and `@amqp-contract/worker` peers now
start at `^3.0.1`, the release that fixes it upstream: start-up fails within
`connectTimeoutMs` (`AMQP_CONNECT_TIMEOUT_MS`) with a `ConnectionError` that
reads `connect ETIMEDOUT`, instead of never settling. A caller's own
`connectionOptions.connectionOptions.timeout` is kept.
