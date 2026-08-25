# @btravstack/di

## 0.3.0

### Minor Changes

- 6f964fa: A module declares what its own providers expect from outside

  `Module(name)({ … })` takes a fourth list, `needs`. A port **this module's own
  providers** read, and that nothing here satisfies, must be named there; anything
  they owe and it does not name is refused at that call, with the port in the
  message:

  ```
  Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
    '{ provides: [...]; exports: [...]; }' but required in type
    '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
  ```

  Before this, a need nothing local satisfied simply travelled to whoever
  composed the module, and a composition root could satisfy an imported module's
  dependency without that module ever mentioning it — measured: a slice's
  provider received the root's service while importing nothing at all. A slice
  directory could not be read on its own.

  `needs` is the explicit stand-in for NestJS's `@Global`, which this container
  does not have and now does not need: the port is named, the supplier is not, so
  the slice still composes into any root that answers it.

  **An import's own needs are not the importer's to re-declare.** They are already
  published in the import's type, and the entry point still refuses a root that
  has not discharged them — so the declaration lands on the feature that reads the
  port, once, rather than on every module between it and the root. That is
  `ConfigModule.forFeature`'s shape reached without a global: `DatabaseModule`
  says `needs: [Env]` because it reads `DATABASE_URL`, and the persistence modules
  and slices that import it say nothing.

  `Scope` is exempt — nothing can provide it, and the entry point discharges it.

  The three starter sugars — `HttpModule`, `AmqpModule`, `TemporalModule` — take
  `needs` too and re-declare the gate over their augmented tuples, so a
  composition root written with a sugar is checked exactly like a bare
  `Module(name)`.

  `@btravstack/di` additionally exports `NeedsGate` and `Unmet`, which a package
  offering its own shaped module needs in order to re-declare the gate.

- 76f58c4: The last mute diagnostics speak. `Module.build`, `Module.scoped` and
  `Module.forkScope` gate unmet dependencies with `DependencyGate`, a marker
  intersected onto the `module` parameter, and `tapped` gates an unexported
  port with `TapGate` on its `ports` array — replacing the conditional rest
  tuples whose failure was a bare arity line (`Expected 3 arguments, but got
1.`) that named neither the label nor the port. The message now ends on what
  is missing: `required in type '{ readonly "UNSATISFIED DEPENDENCIES — nothing
provides": Cfg; }'`. Every gate a composing application meets is now the same
  marker mechanism, and every one prints a name. The phantom rest arguments are
  gone from the signatures; nothing could ever pass values for them.
- 41aa1fb: `Module(name)({ exports })` now accepts a provider as well as a port class,
  normalising it to `provider.port` when the module is built:

  ```ts
  export const OrdersSlice = Module("OrdersSlice")({
    provides: [ordersController],
    exports: [ordersController], // was: [ordersController.port]
  });
  ```

  Both forms mean the same thing and may be mixed in one array — the `Exports`
  channel comes out identical, so `start`'s gate, the unmet-dependency gate and
  `Context<X>` are unaffected. Purely additive: exporting a port class is
  unchanged.

  It matters most where there is no class to name: `HttpController(contract,
path)`, `Config.provider(name)(schema)`, `HttpRouter(contract)(…)`,
  `TemporalActivities` and `AmqpHandlers` all mint their own port and hand back a
  provider carrying it.

- f615282: The testing half of "swapping an adapter is composing a different module".
  `@btravstack/testing`'s `overridden(module, overrides)` substitutes named
  providers into the real composition root — the seam composition cannot
  reach, since nothing can be layered over a graph that already provides a
  port. Its primitive is `@btravstack/di`'s one deliberately test-facing
  export, `overrideProvider`: at plan time the override replaces the base
  provider (which is never constructed), an override with nothing to override
  is a loud `WiringDefect` — the drift gate a hand-maintained parallel root
  never had — and two overrides for one port stay the duplicate defect.
  Production composition stays override-free by convention.
- b8fdee9: The `Unmet` type is gone from `@btravstack/di`

  Its documented purpose — a shaped module re-declaring the gates with it — was
  impossible to serve: declaration emit keeps the alias unreduced, and the
  unreduced form names imported modules' internal ports (TS2883 on the first
  consumer that exports a composition root), which is why every in-repo sugar
  already inlined the computation instead. Inline it; `NeedsGate` is unchanged
  and still exported.

  Internal trims alongside, none of them surface: `@btravstack/http-server` no longer
  memoises scheme ports (di resolves by id, so a fresh class per call is the same
  lookup — measured), and `HasMark`, `authenticatorPort` and `Http.authenticators`
  now carry TSDoc naming the external consumer each exists for, so their lack of
  an in-repo caller stops reading as dead surface.

- d5be140: `Runtime.needs` is `Runtime.resolves`

  Two different `needs` in one framework was one too many. di's `Module` has a
  `needs` — what a composition root supplies it — and the kernel's `Runtime` had
  one too, meaning something else entirely: the ports the runtime reads back out
  of the built application context. They never appear in the same object, which
  is exactly why the collision was easy to miss and easy to misread.

  ```ts
  const runtime: Runtime<typeof Clock> = {
    name: "ticker",
    resolves: [Clock],
    start: (host) => OkAsync(serving),
  };
  ```

  The type parameter is `Resolves` rather than `Needs` throughout —
  `Runtime<Resolves, Info>`, `RuntimeHost<Resolves>`, `RunUnit<Resolves>` — and
  `start`'s gate sentence follows:
  `"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`.

  Every shipped runtime declares `resolves: []`, so an application that composes
  `http()` / `temporal()` / `amqp()` and never writes a runtime by hand is
  unaffected. A **hand-rolled** runtime renames one field.

  The array is still never read at run time — it exists so `Resolves` is
  inferable from the value, and `start`'s gate checks it against the module's
  exports.

- 3bf4036: A contract may name a scope only if its scheme can grant it

  `HttpRouter(contract)` now refuses a contract declaring a scope outside the
  vocabulary its scheme's authenticator was minted with, and the diagnostic ends
  on the offending scope:

  ```
  Property '"UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it"' is
    missing in type 'Authenticated<…, [{ user: ["order:export"] }]>' but required
    in type '{ readonly "UNGRANTABLE SCOPE — …": "order:export"; }'
  ```

  Before this, nothing tied a contract's scope **strings** to what a scheme could
  actually grant. A typo — or a scope asked of a scheme declared with no
  vocabulary at all — compiled, passed every check, and then refused every caller
  on that route with a permanent `403` and no diagnostic anywhere.

  A requirement naming no scopes costs nothing, which is the common case. The
  check is the sibling of the scheme-**name** check di already performs by leaving
  an unknown scheme's port unmet.

### Patch Changes

- 4499df1: A comment earns its line, or it goes

  A quarter of the TypeScript in this repository was comment, and one line in ten
  an inline essay — so a reader looking for the code had to skim past the reasons
  for it. `CLAUDE.md`'s "comment density: sparse" bullet now carries a test: a
  comment earns its line only if it guards a specific line against a plausible
  "simplification", states a symbol's contract as TSDoc, is a directive with a
  reason, or is a `GIVEN`/`WHEN`/`THEN` marker.

  No API changes. What consumers see is the TSDoc these packages ship in their
  declarations: shorter, and stating each symbol's contract rather than the
  history behind it, which lives in the repository and on the documentation site.

- 31f70f7: The repository is `btravstack/btravstack`, so every package's `homepage`,
  `bugs.url` and `repository.url` points there. GitHub redirects the old slug, so
  nothing was broken — but published metadata that names a repository should name
  the one it lives in.

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
