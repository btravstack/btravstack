# .changeset/

Release and versioning policy. The gate commands and the package inventory
live in the root `CLAUDE.md`.

A release bumps every one of the thirteen published packages, whether or not
it changed — Spring Boot's model, and the reason is the same:
an application installs a kernel and two or three starters together, and
"which version of `@btravstack/http-server` goes with `@btravstack/core@0.4.1`" is a
question nobody should have to answer.

**A minor no longer forces 1.0.0 — `@changesets/cli@3.0.0` fixed it.** Every
package here peer-depends on `@btravstack/di` and most on `@btravstack/config`
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
reusable workflow, the chain off a green CI run, the `head_sha` pin, changesets'
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
