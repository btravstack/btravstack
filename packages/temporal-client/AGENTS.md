# packages/temporal-client

This package binds the calling half of Temporal to an application-declared DI
port. `temporalClient(port, options?)` is a `Module`, like the other starters
that peer on `@btravstack/core`: it provides `@temporal-contract/client`'s
`TypedClient` on `port` and a `temporal-client:<port id>` health check, exports
both, and composes `noObserverMember`. The caller binds its contract through
`client.for(contract)`.

- **The application names the port; the connection is private.** A process
  can hold several clients, so the client port stays the application's. The
  settings and the `Connection` are ports derived from its id
  (`TemporalClientSettings:<id>`, `TemporalClientConnection:<id>`), memoised
  so a second call for the same port reuses them, and never exported. The
  connection stays a provider of its own so its cleanup is correct when the
  client provider fails. Nothing outside the module needs the raw connection:
  `client.raw.connection` is the escape hatch.
- **Configuration is the worker's, from `Env`.** `TEMPORAL_ADDRESS` and
  `TEMPORAL_NAMESPACE`, with the worker's defaults, each pinned by its option
  through `Config.pinned`; the security variables are never pinned, as on the
  worker. `ConfigInvalid` names the client's port. The module's type spells
  its needs with `EnvReading` / `Unpinned` / `MaybePinned` (both variables
  default, so they are only ever optional), pinned by `index.test-d.ts`.
- **`dataConverter` and `apiKey` are ports, not values.** A codec's provider
  can inject its key store, and the worker and the client resolve one
  provider; the converter cannot be a variable. Each port joins the needs only
  when given, and `TemporalApiKeyUnavailable` joins the errors only with
  `apiKey`.
- **The health check asks gRPC health for the workflow service**, as the Go
  SDK's `CheckHealth` does, through the provided connection — the rotating
  `Proxy` when files rotate — so it reaches the current connection. It is not
  a readiness gate. Temporal's retry interceptor keeps an `UNAVAILABLE` call
  alive with its own backoff, past the kernel's health timeout: the call
  carries a deadline so it ends, and the connection's release waits for calls
  in flight, since a retry fired on a closed channel throws uncaught from the
  interceptor's timer. `TemporalClientUnreachable` models a failed connection.

This package has no worker dependency and owns no schedule policy. The worked
consumer is `examples/order-temporal-worker/src/schedules.ts`, exercised by
its real Temporal suite. `index.spec.ts`'s configuration and health cases run
against a fake connection or a scripted gRPC server of the test's own, so they
need no container.

The starter owns the SDK's lazy connection before verifying connectivity:
`Connection.connect()` does not close its allocation after a failed handshake.
Initialization failures close it before returning `TemporalClientUnreachable`,
including failed renewable-source reconnects. If cleanup itself fails, an
`AggregateError` preserves both causes as a defect rather than hiding a cleanup
bug as a network refusal.

## Connection security

`connection-security.ts` binds TLS, mTLS and an API key under Temporal's own
environment names (`TEMPORAL_TLS`, `TEMPORAL_TLS_SERVER_CA_CERT_PATH`,
`TEMPORAL_TLS_SERVER_NAME`, `TEMPORAL_TLS_CLIENT_CERT_PATH`,
`TEMPORAL_TLS_CLIENT_KEY_PATH`, `TEMPORAL_API_KEY`), so a deployment written
for Temporal's CLI or SDK environment configuration needs no translation. Two
names are ours: `TEMPORAL_API_KEY_PATH`, because a key that rotates is mounted
as a file, and `TEMPORAL_CREDENTIALS_RELOAD_MS`.

- **The file is duplicated in `temporal-worker` and `temporal-client`, on
  purpose.** Neither starter may depend on the other (a client consumer must
  not install the worker, nor the reverse), and the module is too small and
  too Temporal-specific for a shared package. Change both copies together;
  each package's spec proves its copy.
- **`TEMPORAL_TLS` unset follows Temporal**: on exactly when an API key is
  set. The one departure is `TEMPORAL_TLS=false` with an API key, which
  Temporal's clients accept and this refuses: a bearer token never goes out
  in plaintext.
- **Refusals before reads.** Every combination it cannot connect with is one
  `ConfigInvalid` naming every variable, before a file is opened; then every
  unreadable or empty file, all at once. An API key beside a client
  certificate is refused rather than sent with it: one credential, chosen by
  the deployment.
- **Rotation polls, it does not watch.** `fs.watch` follows the file a Kubernetes
  Secret mount's `..data` symlink swap replaces, and is unreliable on network
  filesystems; a read every `credentialsReloadMs` (default one minute,
  `unref`ed) is cheap and always right. A changed reading is applied, and only
  then becomes the one compared against; a failure keeps the previous one and
  is retried on the next tick. grpc-js's experimental
  `FileWatcherCertificateProvider` was declined: it would need our own copy of
  grpc-js, whose credentials fail `@temporalio/client`'s copy's
  `instanceof ChannelCredentials` checks, and it serves only the client.
- **A TLS change is a new connection**, since neither SDK connection can
  change TLS in place; an API-key change alone is `setApiKey` on the open one.
- **A projected certificate and key are one immutable generation.** File reads
  resolve their targets before opening them and verify those targets afterwards.
  A generation change retries the whole batch within a bound, including when
  garbage collection removed an old target mid-read. Per-file resolution Results
  remain separate until validation, so a missing file cannot hide another empty
  one. Persistent churn is `ConfigInvalid`, never a mixed certificate/key pair.
  This guards atomic symlink generations, not in-place writes or independent
  Secret updates that have no shared publication boundary.
- **The provided `Connection` is a `Proxy` over the current one** when a file
  can rotate. `Client` and `WorkflowClient` read `connection.workflowService`
  on every call, so swapping the target moves them to the new connection;
  `close` is intercepted to stop the reloading, wait for a reload in flight,
  then close the current one. The replaced connection is closed at once:
  grpc-js lets started calls finish. A `with*` call-context scope lives in
  the connection it was opened on (the SDK makes one `AsyncLocalStorage` per
  connection and offers no way to share it), so a call inside one after a
  rotation loses it; documented rather than worked around. An unreadable file
  is reported to `Observers` as `temporal-client` / `reload`, through
  `reloading`'s `unreadable` hook as on the worker, and retried on the next
  tick.

## Application-owned renewable credentials

`TemporalApiKeySource.read()` returns an `AsyncResult<string,
TemporalApiKeyUnavailable>`. The application's port is composed through `apiKey`;
the source owns acquisition, caching and expiry. The starter only polls it with
`credentialsReloadMs`, and never imports an OAuth implementation. A source implies
TLS and excludes inline/file API keys and mTLS. Configuration refusals precede
source reads, and an empty answer is unavailable. Successful changes use
`setApiKey`; credential values never enter diagnostics.

A failed read or apply closes the client connection immediately. The next
successful reading opens a fresh connection even if the credential is unchanged.
Scope teardown stops the polling and waits for an in-flight read before closing.

`api-key-source.spec.ts` uses the shared TLS authentication proxy to exercise real
namespace RPCs and workers, including renewal and credential removal. Existing
file-only rotation keeps its previous-credential retry behavior.
