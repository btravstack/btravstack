# @btravstack/storage

## 0.4.0

### Patch Changes

- @btravstack/config@0.4.0
  - @btravstack/core@0.4.0
  - @btravstack/di@0.4.0

## 0.3.0

### Minor Changes

- 92a7265: A `Storage` port, an in-memory adapter, an S3-compatible adapter with
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

### Patch Changes

- 4499df1: A comment earns its line, or it goes

  A quarter of the TypeScript in this repository was comment, and one line in ten
  an inline essay — so a reader looking for the code had to skim past the reasons
  for it. `CLAUDE.md`'s "comment density: sparse" bullet now carries a test: a
  comment earns its line only if it guards a specific line against a plausible
  "simplification", states a symbol's contract as TSDoc, is a directive with a
  reason, or is a `GIVEN`/`WHEN`/`THEN` marker.

  No API changes. What consumers see is the TSDoc these packages ship in their
  declarations: shorter, and stating each symbol's contract rather than the
  history behind it, which lives in the repository and on the documentation site.

- 31f70f7: The repository is `btravstack/btravstack`, so every package's `homepage`,
  `bugs.url` and `repository.url` points there. GitHub redirects the old slug, so
  nothing was broken — but published metadata that names a repository should name
  the one it lives in.
- Updated dependencies [4499df1]
- Updated dependencies [6f964fa]
- Updated dependencies [76f58c4]
- Updated dependencies [41aa1fb]
- Updated dependencies [fc38b9a]
- Updated dependencies [9af980d]
- Updated dependencies [ccdcc32]
- Updated dependencies [82579e8]
- Updated dependencies [f615282]
- Updated dependencies [b8fdee9]
- Updated dependencies [31f70f7]
- Updated dependencies [d5be140]
- Updated dependencies [3bf4036]
- Updated dependencies [74621a1]
  - @btravstack/di@0.3.0
  - @btravstack/config@0.3.0
  - @btravstack/core@0.3.0
