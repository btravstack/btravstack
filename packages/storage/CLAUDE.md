# CLAUDE.md — @btravstack/storage

The application-service port for object storage: a `Storage` an application
depends on, adapters that provide the `StorageBackend` behind it, and one
composition function whose `instrumented` flag decides whether every operation
is spanned, counted and logged.

The third of issue #62's three ports, on `@btravstack/cache`'s shape exactly —
read that package's `CLAUDE.md` for the two-port rationale and the conditional
return type; only what differs is written out here.

## Public surface

### `@btravstack/storage` (root)

| Export                                                                   | What it is                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `Storage`                                                                | The port an application depends on: `put`, `get`, `delete`, `presignedUrl`. |
| `StorageBackend`                                                         | The port every adapter provides. Not for application code.                  |
| `StorageService`                                                         | The service both ports carry.                                               |
| `StoredObject`                                                           | `{ bytes: Uint8Array; contentType: string }`.                               |
| `ObjectNotFound`                                                         | `{ key }` — only `get` answers it.                                          |
| `StorageUnavailable`                                                     | `{ operation, key, reason }` — the store could not answer.                  |
| `PresignNotSupported`                                                    | `{ key }` — this adapter cannot mint a URL, and says so.                    |
| `storage({ adapter, instrumented? })`                                    | The composition. Instrumented by default; `false` opts out.                 |
| `StorageOptions`                                                         | `{ adapter: Module<StorageBackend, E, N>; instrumented?: boolean }`.        |
| `memoryStorage()` / `memoryStorageProvider()` / `memoryStorageBackend()` | The in-process adapter, as a module, a provider and a service.              |

### `@btravstack/storage/s3`

| Export                             | What it is                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `s3Storage()`                      | The S3-compatible adapter: five `STORAGE_S3_*` variables, one client on the scope. |
| `s3StorageBackend(client, bucket)` | The service over an `S3Client`.                                                    |
| `StorageConfig`                    | The port the five values are bound onto.                                           |
| `s3Schema`                         | The `Config.object` behind it.                                                     |

`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are the package's two
**optional** peers, reached only through this subpath.

What the instrumented form emits, per operation:

| Signal  | Name                                                                                  | Attributes                                              |
| ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| span    | `storage.put` / `.get` / `.delete` / `.presigned_url`                                 | `btravstack.storage.key`; error status on a failure     |
| counter | `btravstack.storage.operations`                                                       | `{ operation, outcome }` — `ok`, `not_found` or `error` |
| log     | `"the object was not there"` at **`info`**; `"the store could not answer"` at `error` | `{ operation, key }`, with the failure as the cause     |

## Decisions

- **A missing object is `not_found`, counted apart and logged at `info`.**
  Asking for something that is not there is an ordinary answer — a caller
  checking whether a document exists yet meets it on the happy path — and a
  dashboard that treats it as a fault teaches its readers to ignore the fault
  line. `StorageUnavailable` is what pages somebody. `PresignNotSupported`
  rides the same arm: it is a "no" the caller can act on, not an outage.
- **`presignedUrl` has no `ObjectNotFound` arm.** Presigning is a signature
  computation that asks the store nothing, so a URL for an absent key is
  minted happily and 404s when followed. Checking would cost a HEAD per call,
  bought for something the caller usually does not want. Measured against
  RustFS: the mint succeeds, the fetch answers `404`.
- **Bytes, not streams.** An object here is a document. Streaming would change
  every signature, adapter and test to serve a case that wants a different
  design anyway — a stated non-goal, not an oversight.
- **`delete` is idempotent**, which is S3's own behaviour rather than a
  fiction layered over it (measured before the port was written).
- **The memory adapter refuses to presign** rather than minting a `file://`
  URL. A fake URL is the worst kind of double: it passes locally and fails in
  the deployment for a reason no test could have shown. The arm exists in the
  port precisely so an adapter that cannot do this can say so.
- **A stored object whose content type the store lost reads back as
  `application/octet-stream`.** The bytes are still right, and a caller cannot
  act on "the type is missing" — an honest default beats an error nobody can
  answer.
- **Path-style addressing is on and not configurable.** Every self-hosted
  store requires it and AWS accepts it, so it is a value that never changes.
  The one case that would want otherwise (a bucket whose name is a valid AWS
  hostname) is a knob to add when a consumer needs it — and `Config` has no
  boolean field today either, so it is two decisions rather than one.
- **The client is a private port.** The same move `RedisConnection` and
  `OtelSdk` make: a resourceful provider is handed back the service it
  acquired, so the client rides the graph and the scope closing destroys it.

## Deliberately not here

- **No streaming, and no presigned writes.** A presigned PUT is a different
  security decision (who may write what, for how long) and belongs to an
  application that has answered it.
- **No listing, no copy, no multipart.** Each is a real S3 feature and none
  has a consumer here; adding them speculatively is what issue #62 says not
  to do.
- **No metadata beyond the content type**, and no tags.
- **No bucket management.** Creating one is deployment, not runtime — the
  test infrastructure creates the gate's bucket, and a deployment creates its
  own.

## Testing

`packages/storage` needs a **Docker daemon**: its S3 specs run against the
shared `rustfs/rustfs:1.0.0-rc.3` in `internal/test-infra`, in one bucket with
a **key prefix per test**. RustFS is pre-1.0 and its `latest` tag moves, so the
exact rc is pinned — and every operation the port needs was measured against
that image _before_ the port was written.

Two failure fixtures, because one cannot reach both arms: an endpoint that is
**not listening** (`http://127.0.0.1:1`) reaches `put`/`get`/`delete`, and a
client whose **credentials will not resolve** reaches `presignedUrl`, which
never leaves the process and so cannot fail on an unreachable endpoint.

Coverage is 100% lines/functions, `test-fixtures.ts` excluded.
`src/module.test-d.ts` pins the needs gate and all five flag arms.
