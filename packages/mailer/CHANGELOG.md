# @btravstack/mailer

## 0.5.0

### Minor Changes

- b921945: Four consistency fixes across the family, found by auditing the thirteen
  packages against each other rather than each on its own.

  **`@btravstack/mailer`'s telemetry namespace was split down the middle.** The
  counter was `btravstack.mailer.sends` while its span attributes were
  `btravstack.mail.recipients` / `.subject` — two prefixes for one package.
  `cache` and `storage` each use one throughout. It is `mail` now, everywhere:

  |            | before                    | after                        |
  | ---------- | ------------------------- | ---------------------------- |
  | counter    | `btravstack.mailer.sends` | `btravstack.mail.operations` |
  | attributes | `{ outcome }`             | `{ operation, outcome }`     |
  | span       | `mailer.send`             | `mail.send`                  |

  The counter is renamed rather than aliased, and the shape now matches
  `cache.operations`, `storage.operations` and `database.operations` — three said
  `operations` with an `operation` attribute, one said `sends` with neither, so a
  dashboard could not group them. **A dashboard reading the old name needs
  updating**; that is the cost of doing it before more people have one.

  **`@btravstack/di` had no coverage gate.** Every other published package
  enforces 100% lines and functions; the container — the package everything peers
  on — was measured at 99.38% lines and 97.18% functions with nothing failing.
  It has its own `vitest.config.ts` now, which is what `vitest.shared.ts`'s own
  comment says a workspace needing more should do. Three tests close the gap: the
  production early-return in the duplicate-port-id warning, `createScope`'s
  default teardown reporter, and the nullish guards that read a forged `Context`
  as empty. `Context`'s phantom variance marker is `/* v8 ignore */`d, since it is
  uncallable by design and the alternative was a weaker gate on the container.

  **`@btravstack/prisma` had a type-test gate that checked nothing** — a
  `test:types` script and a `tsconfig.test-d.json` with no `*.test-d.ts` file to
  run against, so it passed vacuously. It pins six things now, each with mutual
  assignability so a needs list that GAINS a port fails too: the port carries the
  application's own client type, the port id carries its name, the instrumented
  arm needs exactly `Env | Logger | Meter | Tracer`, `instrumented: false` needs
  exactly `Env`, the error channel is the config's unwrapped, and a client with no
  `$disconnect` is refused.

  It also moves to the `exclude` + chained-`tsc` arrangement `core`, `di`,
  `http-server`, `amqp-worker` and `temporal-worker` already use, rather than the
  one `cache`, `mailer` and `storage` use. Both check the files; only the first
  permits `type _X = Expect<…>` aliases, which `noUnusedLocals` rejects under the
  second.

- c118a74: Raise the published Node floor to `>=22`, and use `Promise.withResolvers`.

  Node 20 reached end of life on **2026-04-30**. Every line that still receives
  security fixes — 22, 24, 26 — satisfies `>=22`, so this drops a promise rather
  than a supported runtime.

  **The old floor was never provable.** CI runs the dev toolchain, and pnpm 11
  needs `node:sqlite`, which Node 20 does not have — so no job here could ever
  execute the line `>=20` named, and `ci.yml` said so in a comment. The new floor
  sits on the same major as the matrix's `22.22` row, so the promise is exercised.

  The knock-on is `@btravstack/core`'s: `createDeferred` was an eight-line shim
  for a primitive the platform ships as `Promise.withResolvers`, held back only
  by the floor. It is gone, along with `src/deferred.ts`. `Deferred` was never
  exported, so no public surface moves — the only visible change is the
  `engines` field.

  `packages/core` raises its `lib` to `ES2024` for this, alone in the repository
  and commented where it happens; the shared `@btravstack/tsconfig` base stays on
  `ES2023` until a second package needs otherwise.

### Patch Changes

- Updated dependencies [b921945]
- Updated dependencies [c118a74]
  - @btravstack/di@0.5.0
  - @btravstack/config@0.5.0
  - @btravstack/core@0.5.0

## 0.4.0

### Patch Changes

- @btravstack/config@0.4.0
  - @btravstack/core@0.4.0
  - @btravstack/di@0.4.0

## 0.3.0

### Minor Changes

- 8ed2f9c: A `Mailer` port, a recording adapter a spec asserts against, an SMTP adapter,
  and one composition function that spans, counts and logs every send by
  default — `instrumented: false` opts out.

  `send` answers when the transport accepted the message, which is not delivery;
  a failure comes back as a modeled `MailNotSent` carrying the envelope and the
  transport's own words, **never the body**. Retries are deliberately absent:
  what to do about a failed send belongs to the caller's transport, and
  `examples/order-amqp-worker` answers a `RetryableError` so the broker's own
  budget owns redelivery. `nodemailer` is the one optional peer, behind the
  `@btravstack/mailer/smtp` subpath.

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
