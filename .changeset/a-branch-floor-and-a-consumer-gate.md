---
"@btravstack/http-server": patch
---

`@btravstack/http-server` states its resolution requirement: `node16` or
`nodenext`.

Its `/jwt`, `/session` and `/oidc` subpaths publish no `typesVersions` shim, so
the legacy `moduleResolution: "node"` — which ignores `exports` entirely —
resolves no types for them. That is a decision rather than an omission: a
`typesVersions` block is a hand-kept mirror of the `exports` map that nothing
compares against, and a consumer on legacy resolution cannot use this stack
anyway, since every relative import here carries a `.js` suffix for the same
reason.

A new gate, `internal/consumer-check`, asserts it: it packs every published
package, installs the tarballs into a throwaway project, and runs
`@arethetypeswrong/cli --profile node16` plus `publint` on each — so a
regression under `node16`, `bundler` or ESM/CJS fails, and `node10` is ignored
on purpose.
