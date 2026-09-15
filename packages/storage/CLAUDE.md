# CLAUDE.md — @btravstack/storage

The application-service port for object storage: a `Storage` an application
depends on, adapters that provide the `StorageBackend` behind it, and one
composition function that binds them together, with every operation reported
is spanned, counted and logged.

The third of issue #62's three ports, on `@btravstack/cache`'s shape exactly —
read that package's `CLAUDE.md` for the two-port rationale and the conditional
return type; only what differs is written out here.

## Public surface

The exports are `src/index.ts` and `src/s3.ts` (`@btravstack/storage/s3`), each
with its TSDoc; what the observers make of an operation is `src/instrument.ts`,
and `docs/reference/storage.md` is the reader's page.

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
- **There is no `stat`/HEAD, and the presigned flow does not need one.** The
  confirm step after an upload has nothing to verify: the signature already
  pinned the type, the size and the key, so the only object that URL could have
  produced is the one that was asked for. Whether the write happened at all is
  a row in the application's own database, and a later `get` answers
  `ObjectNotFound` if it did not.
- **The memory adapter refuses to presign** rather than minting a `file://`
  URL. A fake URL is the worst kind of double: it passes locally and fails in
  the deployment for a reason no test could have shown. The arm exists in the
  port precisely so an adapter that cannot do this can say so.

`presignedUrl`'s missing `ObjectNotFound` arm, the application deciding what the
adapter signs, bytes over streams, idempotent `delete`, the
`application/octet-stream` default, path-style addressing and the private client
port are the TSDoc and comments of `src/storage.ts` and `src/s3.ts`.

## Deliberately not here

- **No streaming**, and no multipart parsing anywhere in the family: an upload
  that transits the process is a unit held open for the length of a transfer.
  Presigned writes are what replaced that, and they ship — see the
  `presignedUpload` entry above for what the adapter does and does not decide.
- **No listing, no copy, and no S3 multipart upload.** Each is a real S3 feature and none
  has a consumer here; adding them speculatively is what issue #62 says not
  to do.
- **No metadata beyond the content type**, and no tags.
- **No bucket management.** Creating one is deployment, not runtime — the
  test infrastructure creates the gate's bucket, and a deployment creates its
  own.

## Testing

RustFS (`internal/test-infra`) is pre-1.0 and its `latest` tag moves, so the
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

Observation: see the root `CLAUDE.md`, **Observability is a set port, never a flag**.
