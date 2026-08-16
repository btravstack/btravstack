# @btravstack/di

## 0.2.0

### Minor Changes

- b56501f: Remove `Port.many` and `Provider.member` from `@btravstack/di`, and `withApp`
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

### Patch Changes

- 9ca73c5: `AnyModule`, `AnyProvider` and `Exportable` — the constraints
  `Module(name)({ imports, provides, exports })` puts on its three tuples — are
  exported as types, so a package offering a shaped module (a starter's
  `HttpModule(name)({ router, imports, provides, exports })` sugar, which appends
  its own import and export to what the application wrote) can constrain its
  tuples the same way and hand them to `Module(name)({...})` itself, whose
  return type is then the sugar's, spelled once. `PortClassOf<Id, Service>`
  (`{ portId: Id; new (): PortInstance<Id, Service> }`) is exported as the one
  nameable type of a port class declared inside a helper — what
  `Config.provider(name)(schema)`, `HttpRouter`, `TemporalActivities` and
  `AmqpHandlers` return as `provider.port`, and what a starter spells its own
  fixed port through.

  `Provider(port)(deps, arm)` now returns `Provider<P, E, N> & { readonly port:
typeof port }` — the provider carries the port class it was declared for,
  typed, so a helper that returns a provider on a port it owns (a starter's
  `HttpRouter(contract)(deps, arm)`, `Config.provider(name)(schema)`) hands back
  one value and `provider.port` is what a dependent lists in its deps. Purely
  additive. `PortInstance` is exported as a type for the same reason: a provider
  over a port declared inside a helper needs a nameable declared type when a
  consumer exports it (naming the instance type forges nothing — the brand keys
  stay private).

## 0.1.0

Initial release.

A module-based dependency-injection container for TypeScript. **Ports** are the
vocabulary an application defines for what it needs, **providers** bind a port to
one concrete construction at a single edge, and **modules** group providers while
declaring what they import and what they let anyone else see. Every fallible
construction returns an `unthrown` `Result` rather than throwing.

Wiring mistakes are compile errors — a missing dependency, an internal port
leaking out of a module, a re-export of something never imported. The two that
types cannot catch, a cycle and two providers registered for the same port, are
raised as defects before any factory runs.

### The surface

- **`Port(id)<Service>`** declares a port as a nominal token:
  `class OrderRepository extends Port("OrderRepository")<Shape> {}`. Identity is
  the token, not the shape, so two ports with identical services stay distinct.
  `Port.many(id)<Member>` declares a set port that several providers contribute
  to — a plugin registry, a list of health checks — and reading it returns every
  contribution, accumulated across module boundaries.
- **`Provider(port)(deps?, options)`** binds one port. The options literal picks
  exactly one of five mutually exclusive arms — `value`, `sync`, `make`, `class`,
  or `acquire` + `release` — and supplying more than one is a compile error.
  Every arm also takes optional `onStart` / `onStop` hooks, fired once the whole
  graph has constructed and during teardown. `Provider.member(port)` contributes
  to a set port.
- **`Module(name)({ imports, provides, exports })`** groups providers. Anything
  not exported is private to the module even though the built container is a
  single flat map at runtime, and the privacy is enforced at compile time.
  `Module.build` builds a graph that needs nothing resourceful, `Module.scoped`
  opens a scope for one that does, and `Module.forkScope` layers a short-lived
  scope over an already-built parent — per-request services that must not
  outlive the request but may read what the parent constructed.
- **`Context`** is the built graph: `ctx.get(port)` returns the service, typed
  from the port alone.
- Types: `AnyPort`, `ServiceOf`, `ScopedOptions`, and `Scope`. `PortClass` and
  `ManyPortClass` are exported for declaration emit — a consumer compiling with
  `declaration: true` and exporting a port needs them nameable — not because
  either is meant to be written by hand.

### What it guarantees

- **An unmet dependency does not compile.** Every requirement a graph has not
  discharged shows up in its `Needs`, and the build call's arity gate rejects it
  with an `UNSATISFIED DEPENDENCIES` parameter naming what is missing.
- **A resourceful graph cannot be built without a scope.** `Scope` stays in
  `Needs` for any provider with `acquire`/`release` or an `onStop`, and
  `Module.scoped` is the only entry point that discharges it. Passing such a
  graph to `Module.build` is a compile error, not a runtime leak.
- **Teardown is ordered and survives partial failure.** Finalisers run in
  reverse acquisition order, and a graph that fails half-constructed unwinds
  exactly what it managed to acquire — on success, on failure, and on the
  mid-graph case — before the call resolves.
- **Errors are values.** A failing construction is an `unthrown` `Result` in the
  module's own error channel. A wiring mistake is a defect on the separate
  channel, because it is a bug rather than an outcome.
- **Port identity is unforgeable.** The brand symbols behind a port are never
  exported, so no hand-written object can pass itself off as a port instance.

### Peer dependency

`unthrown` (`^5.0.0`) — install it alongside.
