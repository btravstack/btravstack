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

| Export                                                                   | What it is                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `Storage`                                                                | The port an application depends on: `put`, `get`, `delete`, `presignedUrl`, `presignedUpload`. |
| `StorageBackend`                                                         | The port every adapter provides. Not for application code.                                     |
| `StorageService`                                                         | The service both ports carry.                                                                  |
| `StoredObject`                                                           | `{ bytes: Uint8Array; contentType: string }`.                                                  |
| `ObjectNotFound`                                                         | `{ key }` — only `get` answers it.                                                             |
| `StorageUnavailable`                                                     | `{ operation, key, reason }` — the store could not answer.                                     |
| `PresignNotSupported`                                                    | `{ key }` — this adapter cannot mint a URL, and says so.                                       |
| `storage({ adapter, instrumented? })`                                    | The composition. Instrumented by default; `false` opts out.                                    |
| `StorageOptions`                                                         | `{ adapter: Module<StorageBackend, E, N>; instrumented?: boolean }`.                           |
| `memoryStorage()` / `memoryStorageProvider()` / `memoryStorageBackend()` | The in-process adapter, as a module, a provider and a service.                                 |

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

| Signal  | Name                                                                                                                     | Attributes                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| span    | `storage.put` / `.get` / `.delete` / `.presigned_url` / `.presigned_upload`                                              | `btravstack.storage.key`; error status on a failure     |
| counter | `btravstack.storage.operations`                                                                                          | `{ operation, outcome }` — `ok`, `not_found` or `error` |
| log     | `"the object was not there"` / `"this store cannot mint a url"` at **`info`**; `"the store could not answer"` at `error` | `{ operation, key }`, with the failure as the cause     |

## Decisions

- **A missing object is `not_found`, counted apart and logged at `info`.**
  Asking for something that is not there is an ordinary answer — a caller
  checking whether a document exists yet meets it on the happy path — and a
  dashboard that treats it as a fault teaches its readers to ignore the fault
  line. `StorageUnavailable` is what pages somebody.
- **`PresignNotSupported` shares the outcome and NOT the message.** It is the
  same class — a "no" the caller can act on, not an outage — so the counter
  says `not_found` for both. But the line says `"this store cannot mint a
url"`, because the object may be sitting exactly where it was put, and an
  operator reading "the object was not there" would go hunting for nothing.
  A counter separates ordinary from faulty; a log line has to say what
  actually happened.
- **`presignedUrl` has no `ObjectNotFound` arm.** Presigning is a signature
  computation that asks the store nothing, so a URL for an absent key is
  minted happily and 404s when followed. Checking would cost a HEAD per call,
  bought for something the caller usually does not want. Measured against
  RustFS: the mint succeeds, the fetch answers `404`.
- **`presignedUpload` signs the content type and the content length, and
  `contentLength` is therefore required.** Both are set on the command, so both
  are in the signature and a client sending different ones is refused by the
  store — the URL grants exactly one write, of exactly that size, of exactly
  that type. That is the only ceiling a presigned PUT can express: S3 has no
  "at most n bytes" for this shape, so an optional length would quietly hand
  out an unbounded write. Naming the two in `getSignedUrl`'s `signableHeaders`
  changes nothing — measured against RustFS by removing it, which left the
  mismatched write still refused with `403`. A presigned POST policy WOULD
  express a range, at the cost of a third optional peer and a form-encoded
  return shape; it is not here because nothing has asked for a range.
- **The application decides, the adapter signs.** Who may write this key, for
  how long, and how large is policy, and it stays in the application exactly as
  the earlier "no presigned writes" entry demanded. What moved into the adapter
  is the signature computation, which was never the contested half.
- **There is no `stat`/HEAD, and the presigned flow does not need one.** The
  confirm step after an upload has nothing to verify: the signature already
  pinned the type, the size and the key, so the only object that URL could have
  produced is the one that was asked for. Whether the write happened at all is
  a row in the application's own database, and a later `get` answers
  `ObjectNotFound` if it did not.
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

- **No streaming**, and no multipart parsing anywhere in the family: an upload
  that transits the process is a unit held open for the length of a transfer.
  Presigned writes are what replaced that, and they ship — see the two entries
  above for what the adapter does and does not decide.
- **No listing, no copy, and no S3 multipart upload.** Each is a real S3 feature and none
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
client whose **credentials will not resolve** reaches `presignedUrl` and
`presignedUpload`, which never leave the process and so cannot fail on an
unreachable endpoint.

The upload arm is proved end to end rather than by inspecting a URL: a plain
`fetch` `PUT`s at the minted URL carrying no credentials, and the object is
then read back through the port. Its sibling proves the binding by sending
four bytes at a URL signed for one — `403`, and nothing stored.

Coverage is 100% lines/functions, `test-fixtures.ts` excluded.
`src/module.test-d.ts` pins the needs gate and all five flag arms.

## Health check

The starter contributes one `HealthChecks` member, named `storage`, so the
kernel's `/healthz` reports on it without the application wiring anything. The
probe is a `get` on a reserved probe key — `ObjectNotFound` is the store ANSWERING and therefore healthy; only `StorageUnavailable` is not.

Composing the starter therefore exports `HealthChecks` alongside its own port —
a composition root that re-exports the module whole passes it up to the kernel
with no extra line.

## Observation is a set port, not a flag

Every call this package makes observable is handed to whatever contributed to
`Observers` — `@btravstack/core`'s set port — and this module contributes a
**no-op member of its own**, so a graph composing no observability owes nothing,
installs nothing — an operation costs one inert call per module that reads the port.

`instrumented` is gone. It defaulted to `true` and therefore put `Logger`,
`Meter` and `Tracer` in this module's `Needs`, so a root that wanted a cache and
no OpenTelemetry SDK got a compile error naming three ports and had to find an
option to turn something off it never asked for. A set port has the property the
flag was reaching for and the flag could not have: **on when observability is
composed, free when it is not, and one composition either way.**

**A reader of the port must contribute a member**, the way `otel()` does for
`Instrumentations`: a collector depending on a set port nothing provides is an
unmet dependency, at plan time and in `Needs` alike. Several no-ops in one graph
cost a call each.

**Dimensions and details are separate, and that split is what lets one observer
serve every component.** `attributes` are bounded and ride the instruments;
`details` are unbounded — a cache key, a mail subject, a URL — and ride the span
and the error line only. Without it every contributor would have to choose
between a useful span and a safe metric.

What the observers do with an operation belongs to `@btravstack/observability`:
`observability()` writes a line when one FAILS (never on success — that is what
the metric is for), and `otel()` opens the span and mints
`btravstack.<component>.operations` and `btravstack.<component>.duration`. The
names are derived from the operation's own `component`, so nothing had to become
uniform to be shared.
