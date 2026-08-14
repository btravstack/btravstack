---
"@btravstack/core": minor
---

**Breaking:** `runMain` now takes the module and options directly —
`runMain(AppModule, { runtime })` — booting `start` itself and carrying the
same compile-time needs gate. The old app-taking form is gone: a whole
`main.ts` is one call, and `start` remains the API for callers that want the
`RunningApp` itself (tests, embedders, a dev runner booting two applications —
none of which may claim `process.exitCode`).

The nesting it replaces — `runMain(start(module, options))` — made `start`
look complete on its own, and using it alone in an entry point is the
documented footgun: the kernel's uncaught handlers suppress Node's default
exit 1, so a crash exited `0`. The front door is now the one-call shape the
docs lead with.

Also exports `RuntimeNeedsGate`, the phantom rest-tuple gate `start`,
`runMain` and `withApp` all carry, previously inlined at each site.
