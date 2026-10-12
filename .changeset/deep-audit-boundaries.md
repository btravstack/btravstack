---
"@btravstack/entity": patch
"@btravstack/config": patch
"@btravstack/observability": patch
"@btravstack/mailer": patch
"@btravstack/http-server": patch
"@btravstack/temporal-worker": patch
"@btravstack/amqp-worker": patch
---

Harden validation, diagnostics and shutdown boundaries found by the repository audit:

- Reject entity protocol names in declared and computed fields, and validate nested entities once per construction.
- Omit malformed URL values from configuration errors and apply safe error rendering to Pino logs. Keep the stack's chosen log level as Pino's only filter without changing the supplied logger.
- Report partially rejected SMTP sends with the rejected recipients so callers can retry them.
- Reset SSE responses with queued headers when draining, and close Temporal connections after a worker outlives the drain deadline.
- Correct the API-key authenticator documentation example and compile its actual source sample.
- Clarify that the AMQP connection deadline includes topology initialization, including quorum leader election.
