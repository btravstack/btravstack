# packages/amqp-client

This package binds `@amqp-contract/client` to an application-declared DI port.
`amqpClient(port, contract, options?)` returns a `Module`, the shape of the
other starters that own a dependency (`oauth-client`, `cache`, `mailer`,
`storage`, `outbox`): it peers on `@btravstack/core` and `@btravstack/config`,
provides and exports the client port and `HealthChecks`, and contributes
`noObserverMember`. No application event, outbox mapping, or consumer belongs
here.

The application still names the port, so one process can hold a client per
contract. Everything else the module owns is keyed off it: the module is
named `AmqpClient:<port id>`, `ConfigInvalid` names the port, and the health
check is `amqp-client:<port id>`. There is no private settings port: the
client provider parses `Env` itself, so two clients never collide on an
internal port id.

Configuration is the worker starter's: `AMQP_URL` (default
`amqp://127.0.0.1:5672`) and `AMQP_CONNECT_TIMEOUT_MS` (default `5_000`,
min `0`), pinned by `url` and `connectTimeoutMs` through `Config.pinned`. Both
have defaults, so the needs are `EnvReading<never, …>`: each variable is
optional unless its option is certainly set, when it is not read at all
(`index.test-d.ts`). The worker types the same two as always optional; the
client is stricter because its options are inferred as written. The error
channel is `ConfigInvalid | ConnectionError`; the upstream error stays
unwrapped.

`connectTimeoutMs` does not bound `create` against a broker that accepts TCP
and never answers the handshake (btravstack/amqp-contract#796): `close()`
awaits the in-flight connect, which amqplib bounds only with a socket timeout.
The provider sets that timeout to half the connect timeout. amqplib clears it
once the connection opens (`lib/connect.js`, `sock.setTimeout(0)` in the open
callback), so idle connections are unaffected. Half, not equal: measured on
amqplib 2.2.0, an equal timeout loses the race to `waitForConnect`, `close()`
then waits out the 5 s reconnect interval, and the error loses
`connect ETIMEDOUT`. Remove it once btravstack/amqp-contract#797 ships.

The health check reads `client.isConnected()`, which is `false` while the
library reconnects and after `close()`. It is a `/healthz` member only; it
does not opt into readiness, since a broker shared by every replica would
withdraw all of them at once.

- **`broker-log.ts` is duplicated from `amqp-worker`, on purpose.** Neither
  package may depend on the other (a publisher must not install the worker,
  nor the reverse), and the adapter is too small for a shared package. The
  copy differs in its `Logger` import and in `component: "amqp-client"`.
  Change both copies together; each package's spec proves its copy. It
  reports the library's `warn` and `error` lines (`connectFailed`'s "AMQP
  connection attempt failed; retrying", a channel error, a dropped RPC reply)
  to `Observers` and drops `debug` and `info`, since an observer writes no
  line for a successful operation.

A publisher and worker may share a broker URL while retaining separate
connections; the upstream client and worker use separate pools. Package tests
need no Docker: configuration, cleanup, error propagation and health run
against a spied `TypedAmqpClient.create`, and the silent-broker timeout and
the `connectFailed` observation run the real client against local TCP
listeners. The worked consumer is
`examples/order-amqp-worker/src/outbox-publisher.ts`, exercised by its real
RabbitMQ suite.
