---
"@btravstack/start": minor
---

Remove the `VERSION` export.

It was a hand-maintained copy of `package.json`'s `version`, read by nothing but
a test asserting the literal it was written as — so it could only ever go stale
or fail its own tautology. Neither `@btravstack/start-http` nor
`@btravstack/start-temporal` ever shipped one. A consumer that needs the version
should read it from the package manifest.
