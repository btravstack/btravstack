---
"@btravstack/amqp-client": minor
---

**Breaking:** `amqpClient(port, contract, options?)` now returns a `Module`
that peers on `@btravstack/core` and `@btravstack/config`, instead of a bare
provider over an application settings port. It reads `AMQP_URL` (default
`amqp://127.0.0.1:5672`) and `AMQP_CONNECT_TIMEOUT_MS` (default `5000`), the
worker starter's variables, each pinned by the `url` and `connectTimeoutMs`
options. Its error channel is `ConfigInvalid | ConnectionError`. It contributes
an `amqp-client:<port id>` health check that fails while the client is not
connected, and reports the client library's warnings and errors, such as a
failed connection attempt, to `Observers`.

Migration: install the two new peers, drop the settings port, and move the
call from `provides` to `imports`.

```ts
// Before
Module("Publisher")({
  provides: [amqpClient(OrderClient, orderContract, AmqpConfig), orderPublisher],
});

// After
Module("Publisher")({
  imports: [amqpClient(OrderClient, orderContract)],
  provides: [orderPublisher],
});
```

A settings port that did not read those variables becomes options:
`amqpClient(OrderClient, orderContract, { url, connectTimeoutMs })`.
