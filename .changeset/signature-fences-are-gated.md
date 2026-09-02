---
"@btravstack/testing": minor
---

`BootDefaults` and `SubmittedUnit` are exported.

Both were already documented as part of this package's surface — one is
`bootFixture`'s parameter type, the other what `TestRuntime.submit()` returns —
and `index.ts` exported neither, so a consumer could use them and not name them.

Found by the doc-samples **signature gate** (issue #195), which now checks a
reference page's quoted declaration against the real export in both directions
rather than trusting a skip reason that said the surface "is compiled as the
package itself".
