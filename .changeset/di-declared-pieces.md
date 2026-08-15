---
"@btravstack/di": minor
---

The pieces `Module(name)({ imports, provides, exports })`'s declared type is
built from are exported as types — `AnyModule`, `AnyProvider`, `Exportable`,
`ResolvedExports`, `ErrOf`, `NeedOf`, `PortOf`, `ErrOfModule`, `NeedsOfModule`,
`ExportsOfModule`, `Available` — so a package offering a shaped module (a
starter's `HttpModule(name)({ router, imports, provides, exports })` sugar,
which appends its own import and export to what the application wrote) can
hand back exactly the type `Module(...)` would have over the augmented tuples.
Spell it inline, never through a generic alias.
