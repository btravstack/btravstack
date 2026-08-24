---
"@btravstack/di": minor
"@btravstack/testing": minor
---

The testing half of "swapping an adapter is composing a different module".
`@btravstack/testing`'s `overridden(module, overrides)` substitutes named
providers into the real composition root — the seam composition cannot
reach, since nothing can be layered over a graph that already provides a
port. Its primitive is `@btravstack/di`'s one deliberately test-facing
export, `overrideProvider`: at plan time the override replaces the base
provider (which is never constructed), an override with nothing to override
is a loud `WiringDefect` — the drift gate a hand-maintained parallel root
never had — and two overrides for one port stay the duplicate defect.
Production composition stays override-free by convention.
