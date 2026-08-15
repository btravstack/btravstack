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

`Provider(port)(deps, arm)` now returns `Provider<P, E, N> & { readonly port:
typeof port }` — the provider carries the port class it was declared for,
typed, so a helper that mints the port and the provider together (a starter's
`HttpRouter(name)(deps, arm)`, `Config.provider(name, schema)`) hands back one
value and `provider.port` is what a dependent lists in its deps. Purely
additive. `PortInstance` is exported as a type for the same reason: a provider
over a port minted inside a helper needs a nameable declared type when a
consumer exports it (naming the instance type forges nothing — the brand keys
stay private).
