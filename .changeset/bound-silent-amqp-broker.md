---
"@btravstack/amqp-client": patch
"@btravstack/amqp-worker": patch
---

Bound start-up against a broker that accepts TCP but never answers the AMQP
handshake. `amqpClient`, the AMQP runtime and `amqpSubscription` now set
amqplib's handshake socket timeout to half the connect timeout, keeping a
caller's own `connectionOptions.connectionOptions.timeout`. Start-up fails
within `connectTimeoutMs` (`AMQP_CONNECT_TIMEOUT_MS`) with a `ConnectionError`
that reads `connect ETIMEDOUT`, instead of never settling. amqplib clears the
socket timeout once the connection opens, so idle connections are unaffected.
