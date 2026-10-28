# `@btravstack/temporal-client`

Bind a native Temporal connection and an `@temporal-contract/client`
`TypedClient` to application DI ports. Add
`temporalConnection(connectionPort, settingsPort)` and
`temporalClient(clientPort, connectionPort, settingsPort)` to the module's
providers. Settings supply `address` and `namespace`. The connection closes
with the module scope; an unreachable service returns the modeled
`TemporalClientUnreachable` error.

Pass a fourth port, `temporalClient(clientPort, connectionPort, settingsPort, dataConverterPort)`,
to encode payloads with the `DataConverter` it resolves — the same port the
worker's `dataConverter` option names.

The settings may also carry the connection's security — TLS, a server CA and
name, an mTLS certificate and key, or an API key — and `temporalSecurity` binds
them from Temporal's own variables (`TEMPORAL_TLS`,
`TEMPORAL_TLS_SERVER_CA_CERT_PATH`, `TEMPORAL_TLS_SERVER_NAME`,
`TEMPORAL_TLS_CLIENT_CERT_PATH`, `TEMPORAL_TLS_CLIENT_KEY_PATH`,
`TEMPORAL_API_KEY`, `TEMPORAL_API_KEY_PATH`). Mounted files are read again
every `TEMPORAL_CREDENTIALS_RELOAD_MS`, so a renewed certificate or key is
used without a restart; a combination it cannot connect with is a
`ConfigInvalid`. See the
[reference](https://btravstack.github.io/btravstack/reference/temporal-client#securing-the-connection).

Call `client.for(contract)` to obtain the typed workflow and schedule API.
The [schedule deployment](../../examples/order-temporal-worker/src/schedules.ts)
shows the providers in a real module. Workflow arguments and schedule policy
remain in the application.

`client.for(contract)` also runs a contract's activity with no workflow around
it (Temporal Server 1.32 or later):

<!-- doctest: skip — fragment: `client` and `pdfContract` are the application's -->

```ts
const result = await client.for(pdfContract).executeActivity("renderInvoice", {
  activityId: `invoice-${invoiceId}`,
  args: { invoiceId },
});
```

`startActivity` returns a handle at once and `getActivityHandle` reattaches to
one.
