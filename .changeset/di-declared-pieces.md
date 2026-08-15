---
"@btravstack/di": patch
---

`AnyModule`, `AnyProvider` and `Exportable` — the constraints
`Module(name)({ imports, provides, exports })` puts on its three tuples — are
exported as types, so a package offering a shaped module (a starter's
`HttpModule(name)({ router, imports, provides, exports })` sugar, which appends
its own import and export to what the application wrote) can constrain its
tuples the same way and hand them to `Module(name)({...})` itself, whose
return type is then the sugar's, spelled once. `PortClassOf<Id, Service>`
(`{ portId: Id; new (): PortInstance<Id, Service> }`) is exported as the one
nameable type of a port class minted inside a helper — what
`Config.provider(name)(schema)`, `HttpRouter`, `TemporalActivities` and
`AmqpHandlers` return as `provider.port`.

`Provider(port)(deps, arm)` now returns `Provider<P, E, N> & { readonly port:
typeof port }` — the provider carries the port class it was declared for,
typed, so a helper that mints the port and the provider together (a starter's
`HttpRouter(name)(deps, arm)`, `Config.provider(name)(schema)`) hands back one
value and `provider.port` is what a dependent lists in its deps. Purely
additive. `PortInstance` is exported as a type for the same reason: a provider
over a port minted inside a helper needs a nameable declared type when a
consumer exports it (naming the instance type forges nothing — the brand keys
stay private).
