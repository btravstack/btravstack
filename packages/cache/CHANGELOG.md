# @btravstack/cache

## 0.3.0

### Minor Changes

- f5d7d58: A `Cache` port, an in-memory adapter and a Redis one, and one composition
  function whose `instrumented` flag decides whether every call opens a span,
  counts its outcome — telling a hit from a miss — and logs a failure.

  Adapters provide a `CacheBackend`; `cache({ adapter })` provides `Cache` from
  it, so instrumentation is a decision at the composition root and not a
  decorator applied after the fact (di allows one provider per port per graph,
  which is what makes a wrapper impossible). The flag is off by default, and a
  graph that leaves it off installs no observability at all: `Logger`, `Tracer`
  and `Meter` are `@btravstack/core`'s ports, so this package names them without
  depending on an implementation. `redis` is the only optional peer, behind the
  `@btravstack/cache/redis` subpath.

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
