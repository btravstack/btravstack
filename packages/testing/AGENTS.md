# packages/testing

The test harness. The root `AGENTS.md` is the authoritative spec, and the
surface is `docs/reference/testing.md`; this file holds what only matters under
`packages/testing/`. Keep it in sync with the code and `README.md` in the same
commit.

## Public surface

- **`BootDefaults`** and **`SubmittedUnit`** are exported because a documented
  parameter or return type a consumer cannot name is a surface gap, and the
  doc-samples signature gate is what found both.
- **`testRuntime`'s `Unit` type parameter defaults to `undefined`**, the same
  shape the shipped starters carry: without that default, `Needs` degrades to
  `unknown`.
- **`localIssuer`**, on the `@btravstack/testing/jwt` subpath: a real Keycloak
  or Dex container was considered and declined — either is another daemon on
  the shared `internal/test-infra` roster for a behaviour four lines of `jose`
  already cover exactly, and neither buys back anything this fixture's real
  fetch against a real JWKS does not already prove.

  **The subpath needs Node ≥22.12 under CommonJS.** `jose` is ESM-only, so
  the CJS build's `require("jose")` depends on `require(esm)`, which Node
  enables by default from 22.12. ESM consumers are unaffected on any Node 22,
  and so is every consumer that never imports `@btravstack/testing/jwt` —
  which is why this is stated here rather than paid for by raising the
  package's own `engines` floor, a breaking change for the many to serve the
  few.

- **`overridden`'s `unit` option is applied by the KERNEL, not here** (issue
  #268). A unit module is forked per unit, after the root is built, so wrapping
  the root cannot reach it, and the alternative an application had to write —
  its root as a factory over its kinds, so a spec could pass
  `overridden(UserModule, …)` in — was a test seam in a production file.
  `overridden` contributes the kind-keyed record to `@btravstack/core`'s
  `UnitOverrides` set port (always, `{}` when nothing is named, so there is no
  conditional arm), and `start` maps each kind onto the module the runtime's
  `Runtime.units` binds, wraps it with the overrides, and forks the wrapper in
  its place. Keyed by module identity because `UnitHost.fork` is handed a
  module and never a kind; that is why a module bound under two kinds is
  refused. Two overrides for one port in one kind (nested `overridden` calls)
  are refused there too, rather than left to di's duplicate-override check,
  which would only fire at the first fork. The check is at boot, before
  `runtime.start`, so the drift gate lands where a root-level one does.
  Compile time was not reachable without threading each kind's module
  through every starter's return type, which would have changed pinned
  diagnostics; the one compile-time half is that a unit override's error
  channel must be `never`, as a fork's is.
  `testRuntime` declares `units: { test: unit }`, which is what this package's
  own spec boots against.

## Tests

The kernel invariants this package's specs hold — _"No `Result` is produced
and left unexamined"_ and the abort-from-`registry.abortAll()` one — are listed
in `packages/core/AGENTS.md`, pointing here.

## How the kernel's own specs reach this package

`@btravstack/core`'s specs use `bootFixture`, `testRuntime` and `createFakeClock`,
and this package peers on `@btravstack/core`. Listing it as a devDependency of
core would be a **package-graph cycle turbo refuses**, so it is not one:

- `packages/core/tsconfig.json` maps `paths: { "@btravstack/testing":
["../testing/dist/index.d.mts"], "@btravstack/testing/jwt":
["../testing/dist/jwt.d.mts"] }` for the type checker (the built
  declarations — the source would fall outside core's `rootDir`); a doc
  sample naming a subpath needs its own entry here, which is how `/jwt`
  joined the map. `tsconfig.build.json` (what `tsdown` compiles) empties
  `paths` and drops the spec files, so the published `dist` never sees it.
- `packages/core/vitest.config.ts` aliases `@btravstack/testing` to
  `../testing/src/index.ts` and `@btravstack/core` to `./src/index.ts` at run
  time — one kernel in play, and coverage measures what the specs run.
- `turbo.json`'s `@btravstack/core#typecheck` depends on
  `@btravstack/testing#build`, so the d.ts exists before core is type-checked
  (`test` and `build` need no edge: vitest reads the source, `tsdown` never
  sees the import).
- `knip.json`'s `packages/core` entry carries `ignoreDependencies:
["@btravstack/testing"]`, since the import resolves through neither
  `package.json`.
