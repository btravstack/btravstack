---
"@btravstack/storage": minor
---

A `Storage` port, an in-memory adapter, an S3-compatible adapter with
presigned reads, and one composition function that spans, counts and logs
every operation by default — `instrumented: false` opts out.

A missing object is counted apart from a failure and logged at `info`, because
asking for something that is not there is an ordinary answer and a dashboard
that pages on it teaches its readers to ignore the fault line. `presignedUrl`
has no not-found arm: signing asks the store nothing, so a URL for an absent
key is minted and 404s when followed. The memory adapter refuses to presign
rather than minting a `file://` fiction that would pass locally and fail in
the deployment. `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are
the two optional peers, behind the `@btravstack/storage/s3` subpath.
