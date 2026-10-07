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

4. **Each package loads alone, with only its required peers, at the floors it
   advertises, on the Node it promises.** Checks 1 to 3 compile and lint; none
   of them executes a line. This one installs every package in a project of
   its own and runs its built code with `node`, and each clause is one
   property:

   - **Only its required peers.** The project holds the package's tarball,
     the tarballs of the `@btravstack/*` peers it requires (transitively), and
     its other non-optional peers — read off the PACKED manifest, so the
     ranges are the ones `pnpm pack` rewrote, which a consumer is told.
     Nothing optional is installed: `autoInstallPeers` is on, as it is for an
     npm or pnpm consumer, and it never installs an optional peer. What it
     does install is a third party's own required peer —
     `@prisma/orm-toolchain`'s `@prisma/cli-engine` — which is not this
     package's to declare.
   - **Strict peer validation.** `strictPeerDependencies: true`, so a peer
     range no installed version satisfies — the package's own, or one a
     dependency of its peers states — fails the install. Where the package
     and a `@btravstack/*` peer it requires both name a range for one peer,
     the package's own is the one installed, so a sibling's looser range never
     stands in for it and a stricter one fails the check. The one relaxation
     is `@btravstack/*` among themselves: a tarball's version reads as its
     `file:` path, which no `^0.x` range admits, and they are the same commit
     by construction.
   - **At the floors it advertises.** `resolutionMode: lowest-direct`
     resolves each of those peers to the LOWEST version its range admits,
     not the catalog's. That is the lower-bound check, and it is targeted by
     construction: it covers exactly the peers a package requires, each at the
     one version its range names as enough, and adds no install — the
     catalog's versions are what the rest of the gate already runs on. It is
     what found `@btravstack/amqp-worker` and `@btravstack/temporal-worker`
     admitting `unthrown` releases their own required peers refuse, and
     `@btravstack/http-server` admitting oRPC betas that lack an export it
     imports.
   - **Every entry point, both ways.** Each subpath in `exports` is loaded by
     `import()`, and by `require()` where it publishes a `require` condition —
     from inside the project, with `NODE_PATH` cleared, because pnpm's script
     shims point it at this workspace's store and `require` falls back to it.
     An ESM load proves every named import a peer is asked for exists at the
     floor; a CJS load proves only that the module graph resolves.
   - **An optional adapter stays optional.** The root entry must load. A
     subpath may fail only by not finding a peer `adapters` names for THAT
     subpath, and only one its package declares optional — which is what an
     adapter subpath does when its vendor is absent. Any other failure fails
     the check: a missing package nobody declared, and one adapter reaching
     for another adapter's vendor alike. The manifest does not say which
     subpath needs which optional peer, so `adapters` does, and an entry
     whose subpath starts loading without its peers fails as stale.
   - **On the Node it promises.** Every package states one `engines.node`
     (`>=22`), and the check reads its floor off the manifests (`22.0.0`),
     fetches that Node with pnpm's `node@runtime:` protocol and runs every
     load on it as well as on the Node running the check. That is
     independent of the repository's own floor, which `engineStrict` pins to
     the dev toolchain's highest demand, and it needs no matrix row: the
     Tests job's matrix comes from the reusable workflow, and this rides the
     Type Check job like the rest of this workspace.

   What fails for a reason the package cannot fix on its own is in `gaps`,
   with why — CJS consumers of `@btravstack/http-server` on Node below 22.12,
   since `@orpc/server` is ESM-only and `require(esm)` ships unflagged from
   there, and every CJS consumer of `@btravstack/temporal-worker`, since
   `@temporal-contract/worker` exports `./activity` under `import` alone.
   Each gap names one entry point, one mode, one Node and the one error code
   it excuses, so a sibling entry breaking, or the same entry failing some
   other way, is still reported; a gap whose load stops failing with that code
   fails as stale, like `accepted`.

   **What it does not prove**: that the code WORKS at the floors — a method
   added to a peer after its floor is called, not imported, and loading never
   calls it — that an adapter subpath loads with its optional peer installed,
   or anything at a version between a floor and the catalog's.

## How it works

`pnpm pack` every published package into a temporary directory, `pnpm init` a
throwaway project there, `pnpm add` the tarballs plus the peers they need, and
compile. Then, in a second temporary directory beside it — never inside it,
since Node resolves a bare specifier by climbing directories and would find
the first project's packages — one project per package for check 4. Nothing is
cached and nothing is hand-listed: the package list comes from the workspace,
and the compile and the loads run against whatever was just built.

The cost is a few CI minutes, inside the existing Type Check job. Check 4 adds
one small install per package, mostly from the store the first install filled
— only a floor the catalog does not pin is downloaded — plus one Node download.

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
