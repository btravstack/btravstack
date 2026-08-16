---
"@btravstack/di": minor
"@btravstack/testing": minor
---

Remove `Port.many` and `Provider.member` from `@btravstack/di`, and `withApp`
from `@btravstack/testing`.

Set ports had no consumer: not one of the eight packages or ten example
workspaces declared one. The exemption they needed had rippled into the
container's levelling pass, which kept two count maps and a provider-identity
`Set` so a set port's later members were not dropped once the first landed;
readiness is now one membership test. Gone with them: the `MANY` brand,
`ManyPortClass`, `MemberOf`, and the "registered as both a set port and an
ordinary port" wiring defect.

`withApp` was the callback harness that predated `bootFixture`, which does the
same job — start, stop on every exit path, rethrow a shutdown `Defect` — inside
the `test.extend` protocol the Test conventions mandate. Every example and
every starter already used `bootFixture`; only the kernel's own four invariant
specs still called `withApp`, and they now take the `boot` fixture.
