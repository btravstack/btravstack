---
"@btravstack/http-server": patch
---

The `@unthrown/orpc` peer range is now `^0.2.0`. It said `^0.1.0`, which on a
`0.x` line excludes the 0.2.0 this package is built and tested against, so a
consumer installing both under `strictPeerDependencies` was refused.
