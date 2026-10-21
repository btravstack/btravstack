# .changeset/

Release and versioning policy. The gate commands and the package inventory
live in the root `AGENTS.md`.

A release bumps every one of the twenty-five published packages, whether or not
it changed — Spring Boot's model, and the reason is the same:
an application installs a kernel and two or three starters together, and
"which version of `@btravstack/http-server` goes with `@btravstack/core@0.4.1`" is a
question nobody should have to answer.

**A minor no longer forces 1.0.0 — `@changesets/cli@3.0.0` fixed it.** Every
package except `entity` peer-depends on `@btravstack/di` and most on `@btravstack/config`
and `@btravstack/core`, and changesets 2.x majored any package whose _peer_
dependency was bumped by a minor or major; from 0.x a major is `1.0.0`, so one
`minor` changeset took the whole group there. Re-measured on **3.0.0**, twice,
against the four pending changesets:

| From 0.2.0          | on 2.31.1                 | on 3.0.0    |
| ------------------- | ------------------------- | ----------- |
| a `patch` changeset | `0.2.1` — the whole group | `0.2.1`     |
| a `minor` changeset | `1.0.0` — the whole group | **`0.3.0`** |

Only the `minor` row moved, and it moved to what the repo wanted all along.
The escape hatches the 2.x note prescribed are moot: both lived under
`___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`, **not** in the ordinary
config, and neither was the `updateInternalDependencies` this repo's
`.changeset/config.json` already sets — the names are close enough to mislead
(`onlyUpdatePeerDependentsWhenOutOfRange: true`,
`updateInternalDependents: "out-of-range"`, both read by
`@changesets/assemble-release-plan`, both tried, neither changing the 2.x
result). The internal peers still cannot become ordinary dependencies — the
dual-copy hazard is what they exist to prevent.

## Documentation changes can require an empty changeset

The CI Changeset job runs `changeset status --since=origin/main`. A package
README or guidance edit counts as a changed package even when no runtime or
manifest changed. Add an empty changeset (`---` followed by `---`, with no
package entries) for such documentation-only changes. It satisfies that gate
without releasing the fixed package group. A user-facing runtime change still
names its package and release type.

## A private workspace package still needs a `version`

`pnpm publish` rewrites every `workspace:` dependency into a concrete range —
**`devDependencies` included** — and it cannot do that for a workspace package
that has no `version` field. `@btravstack/internal-test-infra` is `private: true`
and had none, which is why the `0.3.0` release published `@btravstack/di` and
then failed on the packages that devDepend on it:

```text
ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL: Cannot resolve workspace protocol
of dependency "@btravstack/internal-test-infra" because this dependency is not
installed. Try running "pnpm install".
```

**The message is misleading and cost the diagnosis time**: the dependency IS
installed — `packages/cache/node_modules/@btravstack/internal-test-infra` is a
live symlink. What pnpm cannot do is resolve `workspace:*` to a version that
does not exist. `pnpm install` changes nothing.

So every workspace package a **published** package depends on, in any
dependency field, carries a `version` — `0.0.0` for the private ones, which
`private: true` still keeps off the registry. The examples and `docs` need none:
nothing published depends on them.

The published manifests therefore carry
`"@btravstack/internal-test-infra": "0.0.0"` in `devDependencies`, naming a
package that is not on npm. That is inert — a consumer never installs a
dependency's devDependencies — and it is the standard cost of this fix.

## Releasing is CI's job from 0.4.0 onward

`.github/workflows/release.yml`'s own comments describe the flow: the
local release steps, the chain off a green CI run, the `head_sha` pin, changesets'
two-step, and the two things it needs outside the file (`RELEASE_PAT` and a
Trusted Publisher per package). One gotcha lives only here.

**`changesets/action` must stay on v2 or newer.** v1 bundles
`@changesets/read@^0.6.7`, which parses every `.changeset/*.md` as a changeset —
**including this file** — and fails the release with
`could not parse changeset - missing or invalid frontmatter`. That is not a
hypothetical: it is what this repository's first automated release run did.
`@changesets/read@1.0.0` ignores `README.md`, `AGENTS.md`, `CLAUDE.md` and
`GEMINI.md`. A local `pnpm run version` never showed it, because a repository
installs a current reader and only the action's bundled copy was old — so the
failure existed in CI and nowhere else.

## The standalone template follows the release

`templates/http-app` is outside the workspace, so Changesets cannot update its
pins. The root `version` script runs `.changeset/sync-template.mjs` after
Changesets to copy each framework package's new version into the template,
leaving third-party pins unchanged. The release workflow uses that script,
so the release PR carries the template update too.

The consumer gate rejects template pins that differ from repository versions.
It installs the declared versions from npm once published. A release PR's
version is not published yet: only an npm `E404` selects source tarballs for
that stage's strict-peer install, compiler, endpoint and SIGTERM check. Other
registry errors fail; the stage is named in the output. The retained version
regression runs through the consumer-check workspace's `test` script with
real Changesets patch and minor bumps in a temporary copy.

The version regression copies workspace manifests directly, without walking
package contents. Tests run alongside builds and packing: pnpm's temporary
files can disappear during a recursive directory walk, so filtering those
walks with `statSync` made the Node 24 CI row fail with `ENOENT`. The release
fixture needs only manifests, not generated output or package sources.

## Empty changesets must not suppress publication

`changesets/action` v2.1.2 returns successfully without publishing when every
remaining changeset is empty. A docs-only changeset can survive the version
PR, leaving already-versioned packages unpublished despite a green release
job. The release workflow removes standard empty-frontmatter changesets from
its runner checkout before invoking the action. Named releases and guidance
files remain; committed changesets are untouched. With no pending release
entries the action attempts to publish unpublished versions, and an existing
published version remains a no-op.

The workflow keeps its own pinned steps because the shared workflow offers
no preparation hook before the action reads changesets. It preserves the
successful own-repository push guard, tested-commit checkout, PAT and npm OIDC
permissions. It skips stale CI runs when `github.sha` differs from the tested
`head_sha`: the action uses the former for release branches and publication
tags. Checkout does not persist the PAT; the action receives it separately,
so dependency installation has no saved write credential to read.
The consumer-check test command runs the cleanup regression
alongside the template version regression. A new named changeset is not added
for this workflow repair: 0.34.0 is already versioned and must not be bumped
again merely to publish it.

## A new npm package must be bootstrapped before the group publishes

The release script checks every fixed-group name on the configured npm registry
before building or publishing. A missing or unreadable package stops the whole
release, and a registry error also stops it; an npm 404 is never permission to
start a partial publication. The check uses npm's registry and certificate
configuration. It cannot verify Trusted Publisher settings or make the registry's
multiple publications atomic.

The 0.39.0 release published the HTTP runtime but left its matching HTTP adapters
unpublished after the new `http-client` package failed with npm 404. Source and
consumer gates were green; applications installing the latest published packages
could not load oRPC because its older adapter imported a removed internal export.

For a new package, an npm maintainer must publish its initial version and configure
its Trusted Publisher for this repository and `release.yml` before release CI
runs. Verify registry access first: npm can also hide inaccessible packages with 404. To recover a partially published group, finish that setup and rerun the failed
release job. Changesets skips the versions already published and publishes those
still missing. Do not bump the group merely to retry it, and never replace an
existing tarball. This workflow repair has no named changeset for that reason.
