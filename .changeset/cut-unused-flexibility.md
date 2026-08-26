---
"@btravstack/http-server": minor
"@btravstack/prisma": minor
"@btravstack/testing": minor
---

Remove four pieces of public surface nobody uses.

**`HasMark<C>` is gone** from `@btravstack/http-server`. It existed for exactly
one hypothetical consumer — its own TSDoc said so: "exported for tooling over a
contract — an OpenAPI generator deciding whether to emit `security` at all."
That generator now exists, and it uses `isAuthenticated` instead, because
emitting `security` needs the requirements rather than a boolean. Its only other
references were two type tests asserting `HasMark` against itself.

**`urlVar` is gone** from `prismaDatabase`. It was added so two databases in one
application would not collide on `DATABASE_URL`; no application has a second
database, no spec set it, and the collision it prevented has never happened.

**The `client` arrow takes only the adapter now**, not `(adapter, url)`. The URL
was passed for a client that wanted it directly; every documented sample takes
`(adapter)`. The one place that read it was a spec asserting the URL reached the
adapter — which now reads it **off the adapter**, a stronger assertion than the
argument allowed, since it proves the thing that actually reaches Postgres was
configured.

**`BootDefaults` and `SubmittedUnit` are no longer exported** from
`@btravstack/testing`. Both stayed internal types; neither had a consumer
outside the package, and neither TSDoc named one — which is this repository's
own bar for a library-facing export.

Nothing here changes behaviour. Each was flexibility added ahead of a need that
did not arrive, and three of the four were added within the last week.
