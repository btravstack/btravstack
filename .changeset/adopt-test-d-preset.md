---
---

Every `tsconfig.test-d.json` is two lines over `@btravstack/tsconfig/test-d.json`.

Nineteen workspaces each wrote out `noUnusedLocals: false` and
`noUnusedParameters: false` by hand, and none of them wrote down why — an
assertion binding (`type _x = Expect<Equal<A, B>>`) is never read, so both
checks have to be off for that project and on everywhere else. The preset
carries the flags and the reason; each workspace states only its own globs.

Empty on purpose: no published package changes. Every one of them ships
`files: ["dist"]`, and a `tsconfig.test-d.json` is not in the tarball.
