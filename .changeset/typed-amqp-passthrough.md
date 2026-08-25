---
"@btravstack/amqp-worker": minor
---

`connectionOptions` and `defaultConsumerOptions` are typed by
`@amqp-contract/worker`'s own types instead of `Record<string, unknown>` — on
`amqp()` and on the `AmqpModule` sugar alike. `defaultConsumerOptions` takes
the library's exported `ConsumerOptions` (`prefetch`, `priority`,
`arguments`, `consumerTag`, `exclusive`); `connectionOptions` takes the new
`AmqpConnectionOptions` alias (heartbeat, reconnect interval, `findServers`,
TLS/socket options), exported from the package because the library declares
the type without exporting it by name. A key the library does not accept is
now a compile error at the composition root instead of a silently ignored
setting.
