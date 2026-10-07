# @btravstack/internal-consumer-check

Two gates in this repository answer a question **about a consumer** from
**inside the workspace**, where the answer can differ. This workspace asks it
from outside.

It is private, publishes nothing, and its whole surface is one `typecheck`
script — the same move that put `markdownlint` on `lint`: it rides an existing
CI job rather than asking another repository for a new one.

## What it checks

1. **A consumer can emit declarations over this framework's own types.**
   `examples/di-hexagonal`'s emit guard already proves this for a consumer
   exporting a **di** port, and it is the only reason that workspace cannot be
   deleted. Nothing did the same for the shapes a consumer actually exports:
   `defineHttp(...)`'s `api`, an `HttpModule`, a `Config.provider`. The three
   example deployments sit on `@btravstack/tsconfig/app.json`
   (`declaration: false`) **precisely so they never see TS4023**, so they could
   not answer it either.

   `src/consumer.ts` is that file, compiled under `declaration: true`,
   `moduleResolution: node16`, and TypeScript 5.9.3 — the version a consumer
   realistically holds, not the repository's own — installed into the
   throwaway project beside the tarballs, so this workspace depends on no
   copy of it.

2. **The tarballs are well formed.** `publint` on each, plus
   `@arethetypeswrong/cli --pack`, which is what caught that the
   `@btravstack/http-server` subpaths resolve no types under legacy `node10`
   resolution. See **The node10 decision** below.

3. **No tarball grew by half since its last release.** Each packed package's
   contents are summed and compared against `npm view <name> dist.unpackedSize`;
   above `BUDGET` (1.5×) the check fails. CI's Bundle Size job comes from the
   reusable workflow and only reports `du`, so the budget rides here, beside the
   packing it needs. The ratio's reason is `BUDGET`'s TSDoc: features move a
   package by a few percent, a mistake in what ships doubles it. Growth that is
   meant goes in `accepted` with its reason until the next release makes it the
   baseline, and an entry for a package back under budget fails as stale, so an
   exemption cannot outlive the growth it was for; a package npm has never seen
   has no baseline and is skipped.

## How it works

`pnpm pack` every published package into a temporary directory, `pnpm init` a
throwaway project there, `pnpm add` the tarballs plus the peers they need, and
compile. Nothing is cached and nothing is hand-listed: the package list comes
from the workspace, and the compile runs against whatever was just built.

The cost is about two CI minutes, inside the existing Type Check job.

## The node10 decision

`@arethetypeswrong/cli` reports the `/jwt`, `/session` and `/oidc` subpaths of
`@btravstack/http-server` as resolving no types under **`node10`** — the legacy
`moduleResolution: "node"` — because that algorithm ignores `exports` entirely
and this package publishes no `typesVersions` shim.

**That is accepted rather than fixed, and the check asserts it stays that way
for `node10` alone.** A `typesVersions` block is a hand-kept list of every
subpath, which is exactly the kind of parallel list this repository deletes on
sight — and it would be a list nothing compares against the `exports` map it
mirrors. More to the point, a consumer on legacy resolution cannot use this
stack at all: every relative import here carries a `.js` suffix because
`moduleResolution: "nodenext"` requires it, and the tutorial says so in its
first step.

So the requirement is **`node16`/`nodenext` consumers**, stated in the
package README rather than shimmed around. The check fails on a `node16`,
`bundler` or ESM/CJS regression and ignores `node10`.
