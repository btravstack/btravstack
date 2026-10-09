---
"@btravstack/orpc-server": minor
"@btravstack/htmx-server": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
"@btravstack/core": minor
---

`inject` is optional, absent meaning `{}`, on `OrpcController`, `OrpcRouter`,
`HtmxGet`, `HtmxPost`, `TemporalWorkflowActivities`, `TemporalActivities`,
`AmqpHandler` and `AmqpHandlers`. A piece whose every dependency comes off the
unit declares `unit` alone instead of `inject: {}` beside it.
