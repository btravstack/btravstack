# packages/di

The container. It was its own repository (`btravstack/di`) until it was merged
here with its history; the root `CLAUDE.md` owns the framework's thesis and the
conventions, and this file holds what only matters when you are working under
`packages/di/`. Keep it in sync with the code in the same commit.

`@btravstack/di` — a module-based dependency-injection container for TypeScript.
Ports are the vocabulary an application defines, providers bind them at one
edge, modules declare `imports`/`exports`. Every wiring mistake the type system
can catch is a compile error; what it can't (cycles, duplicate providers)
surfaces as a defect before any factory runs. Nothing throws to callers: every
fallible operation returns an
[`unthrown`](https://github.com/btravstack/unthrown) `Result` (peer dependency).

It is the one published package here with no dependency on the kernel — the
arrow runs the other way, and `@btravstack/core` peers on it. `packages/di` must
never import from another workspace package.

## Architecture

All runtime code lives in `packages/di/src`, one concept per file:

- **`port.ts`** — `Port("Id")` returns a phantom class; consumers write
  `class OrderRepository extends Port("OrderRepository")<Shape> {}`. Identity is
  nominal via module-private `unique symbol` brands (`ID`/`SERVICE`) —
  deliberately unexported so port instances are unforgeable. `Scope` is a
  phantom port (service shape `never`) that resourceful providers add to
  `Needs`. There are no set ports: `Port.many`/`Provider.member` were removed
  once an audit found no consumer in any of the eight packages or ten
  examples, and the exemption they needed had rippled into `plan`'s levelling
  (a `Set<AnyProvider>` plus two count maps, now one membership test).
- **`provider.ts`** — `Provider(Port)({ name: Dep }, arm)` with a construction family of
  mutually exclusive option arms: `value` / `sync` / `make` (fallible, returns
  `Result`) / `class` / `acquire`+`release` (resourceful — puts `Scope` in
  `Needs`). Exclusivity is enforced by giving each arm the other keys as optional
  `never`. Deps are a **record**, never an array or a parameter list, and the
  factory receives one services record keyed the same way; a provider that
  declares none omits the record entirely, which is what the two overloads'
  arity discriminates.

  **The keyed form costs point-free, and that is accepted rather than a
  formatting accident.** `Provider(OrderRepository)([Database], { sync:
prismaOrderRepository })` handed the factory straight to `sync`; the same
  provider now has to spell `{ db: Database }, { sync: ({ db }) =>
prismaOrderRepository(db) }` — an adapter factory takes the client, not a
  record, so the wrapper arrow is unavoidable, and oxfmt then breaks the
  two-argument call across lines. That is inherent to naming dependencies:
  a name only exists at a call site if something writes it. One shape was the
  decision (the library is experimental and two spellings of one idea is the
  thing it declines to ship), so this is its price, not a bug to route around.
  Do not reintroduce a positional arm to recover it.

  `overrideProvider(provider)` (issue #63) marks a provider — via a
  module-private symbol, so this call is the only mint — to REPLACE the base
  provider for its port at plan time; `isOverride` is the package-private
  predicate `build.ts` reads. Test-harness-facing, stated in its TSDoc and in
  `index.ts`: `@btravstack/testing`'s `overridden` is the intended caller,
  and production composition stays override-free by convention.

- **`module.ts`** — the `Module<Exports, E, Needs>` algebra. Four option
  tuples — `imports`, `provides`, `exports`, `needs` — and three phantom
  channels with a deliberate variance rule: capability channels (`_exports`) are
  contravariant ("you may forget what you have"), obligation channels (`_error`,
  `_needs`) are covariant ("you may not forget what you owe"). Entry points hang
  off the `Module` const: `Module.build` (requires `Needs = never`),
  `Module.scoped` (opens a scope, excludes `Scope` from the check, guarantees
  close on every path), `Module.forkScope` (per-request scope seeded from a built
  parent `Context`). Unmet dependencies are compile errors via `DependencyGate`, a
  marker intersected onto each entry point's `module` parameter (issue #93):
  `unknown` when the remaining `Needs` is `never` — invisible in an
  intersection — and `{ readonly "UNSATISFIED DEPENDENCIES — nothing
provides": N }` otherwise, so the argument fails assignability and the
  message **ends on the missing ports** (measured:
  `Property '"UNSATISFIED DEPENDENCIES — nothing provides"' is missing in
type 'Module<Repo, never, Cfg>' but required in type '{ readonly
"UNSATISFIED DEPENDENCIES — nothing provides": Cfg; }'`). It replaced a
  conditional rest tuple whose failure was the arity line alone —
  `error TS2554: Expected 3 arguments, but got 1.` — with the label and ports
  unreachable in the message and four documents teaching how to hand-spell
  the phantom arguments around it. Same mechanism as `NeedsGate` below and
  `@btravstack/core`'s `StartGate`: **one gate shape everywhere**, with di's
  marker an object ending on the ports where `start`'s is a fixed sentence.
  The covariant `_needs` refusal is unchanged beside it — the gate is a
  message, not the check.
  `needs` is the fourth tuple and the subject of **Module visibility** below:
  what this module expects a composition root to supply, named. Anything it
  owes and did not name is refused at the `Module(name)({...})` call by
  `NeedsGate`, which rides an intersection on the options parameter.
  `exports` accepts an available **port class**, a **provider** for
  one (normalised to `provider.port` when the module is built, so the stored
  `exports` array stays `readonly (AnyPort | AnyModule)[]`, and yielding the
  identical `Exports` channel either way), or an imported module. The provider
  arm is what the port-minting helpers need — `Config.provider(name)(schema)`,
  `HttpController(name, fragment)` — where there is no class to name.
- **`build.ts`** — `flatten` (dedupe by provider reference), `plan` (levels
  providers for concurrent construction; detects cycles, duplicate providers,
  providers for `Scope`, missing providers — all
  _before_ any factory runs; its first act is `resolveOverrides`, which
  replaces each overridden base with its override so the base is never
  levelled or constructed, and throws the two override defects — "nothing to
  override", the drift gate a fixture gets, and "two overrides registered" —
  on the same pre-construction channel), `run`, `runScoped`. Wiring bugs are thrown as
  `WiringDefect` inside a `.map` callback on purpose: unthrown converts the throw
  into its `Defect` channel, which is where wiring bugs (vs. modeled failures)
  belong.
- **`lifecycle.ts`** — constructs one level concurrently; collects `onStart`
  hooks, which fire only after the whole graph is built, in declaration order.
- **`context.ts`** — the built container: a flat map, `Context<R>.get(port)`.
  Internal `unsafeAdd`/`unsafeAddAll`/`unsafeKeys` are package-private, not
  exported from `index.ts`.
- **`scope.ts`** — `createScope`: finalisers run LIFO on close; a throwing
  finaliser is reported (via `onTeardownError`) and swallowed, never rethrown, so
  teardown always completes and never masks the original failure.
- **`index.ts`** — the deliberate public surface. `Scope` is exported as a _type
  only_ (the class value would let consumers provide or alias it);
  `PortClass` is exported solely so declaration emit works for
  consumers who export ports; `PortInstance` and **`PortClassOf<Id, Service>`**
  (`{ portId: Id; new (): PortInstance<Id, Service> }`, both types only) so a
  provider over a port declared inside a helper — one minted per call
  (`Config.provider("RelayConfig")(schema)`) or the helper's own fixed one
  (`HttpRouter(contract)({ name: Dep }, { sync })`, on `@btravstack/http`'s
  `HttpRouterPort`) — has a nameable
  declared type when a consumer exports it: the class expression
  `class extends Port(id)<S> {}` has an anonymous type declaration emit cannot
  name across packages (TS4023, measured), `PortClassOf` is its nameable
  spelling, and naming the instance type forges nothing (the brand keys stay
  private). `Provider(port)({ name: Dep }, arm)`'s return type is `Provider<P, E, N> &
{ readonly port: typeof port }` — the provider carries its port class typed,
  so `provider.port` is what a dependent lists in its deps; purely additive. `AnyModule`, `AnyProvider`,
  `Exportable` and **`NeedsGate`** are exported so a package offering a **shaped module** (a
  starter's `HttpModule(name)({ router, imports, provides, exports })` sugar,
  which appends its own import and export to what the application wrote) can
  constrain its `imports`/`provides`/`exports` the way `Module(name)` does and
  then hand those tuples to `Module(name)({...})` itself — whose return type is
  then the sugar's, spelled once, here. (Spelling it again in the sugar
  through a named generic alias was tried and removed: declaration emit keeps
  such an alias unreduced and cannot name imported modules' internal ports —
  TS2883 on the first consumer. `ModuleDeclaration`'s own return type stays
  inline for the same reason.)

### Type-level tests

Behaviour that exists only at the type level (phantom-channel variance, arm
exclusivity, `Scope` gating) is pinned in `src/*.test-d.ts` via
`@ts-expect-error`, checked by `tsc --noEmit -p tsconfig.test-d.json` (part of
`pnpm typecheck`). These files are excluded from the main tsc pass, from oxlint,
and from lefthook's pre-commit lint. If you change a type-level guarantee, update
the matching assertion. `src/type-assert.ts` (`Equal<A, B>`) is a test-only
helper, excluded from knip.

### Two TypeScript versions

The catalog pins `typescript` 7.0.2 (what the repo builds with) and
`typescript-consumer` (alias for 5.9.3 — what a consumer is realistically on).
`examples/hexagonal-order-api`'s `typecheck` compiles declaration emit with
_both_ and re-checks the emitted `.d.ts` under the consumer version;
`src/emit-guards.ts` there is the fixture keeping the emitted declarations free
of unnameable private types (the TS4020 class of bug). It is the only workspace
here that compiles twice, and the only reason the `typescript-consumer` catalog
entry exists.

### The one example that came with it

`examples/hexagonal-order-api` exercises the container from a real consumer
workspace (`workspace:*`, own `unthrown` dep since it's a peer) and predates the
kernel — it composes a `Module` and never calls `start`, which is what makes it
the container's own test rather than the framework's. It survived the merge on
the declaration-emit guard above; `plugin-registry` and `request-scope` did not,
because `fork.spec.ts` already pins what the second asserted (and `order-api`
forks a real per-request scope besides); the first went with `Port.many`
itself.

## Module visibility: a need is DECLARED, never absorbed

**Decided in #50: a module states what its OWN providers expect from outside,
and anything they owe and it did not state is a compile error at that module.**
`needs` is the explicit stand-in for NestJS's `@Global` — a composition root
may supply a port to a module it imports, but only one that module asked for by
name.

**An import's own unmet needs are not the importer's to re-declare**, and that
half is deliberate. They are already published in the import's type — the
`imports` entry a reader is looking at says `Module<X, E, Env>` — and `start`
still refuses a root that has not discharged them, so leaving them out hides
nothing. Re-declaring them bought one line per module per hop: measured on this
repo, **12 of 22 declarations were pure propagation**, and dropping them leaves
exactly the modules that read the port. `Env` is the case that showed it — six
declarations in `order-api`, one of them the feature that reads
`DATABASE_URL`. This is the per-feature shape NestJS's
`ConfigModule.forFeature` has, reached without a global.

```ts
export const AuditSlice = Module("AuditSlice")({
  needs: [Logger],
  provides: [orderAudit],
  exports: [orderAudit],
});
```

### What it replaced, and why the first answer was wrong

The model before this was "a need bubbles up until some ancestor discharges
it". A first pass at #50 measured the SIBLING case — a module that imports
`observability()` and re-exports nothing does not discharge another module's
`Logger` — and concluded from it that di already had NestJS's visibility rule.
That is false in the direction the issue was actually about. Measured, both
ways:

```ts
const Slice = Module("Slice")({
  provides: [RepositoryProvider],
  exports: [OrderRepository],
});
const Root = Module("Root")({
  imports: [Slice],
  provides: [DatabaseProvider],
  exports: [OrderRepository],
});
const rootNeedsNothing: Equal<Channels<typeof Root>[2], never> = true; // compiled
```

```
✓ a slice's provider receives the ROOT's service, importing nothing
```

So a slice genuinely did see providers from the root, and `slices/audit/` said
nothing about where its `Logger` came from. Both halves are gone: the module
names the port, and a root that offers one nobody asked for is offering it to
nobody.

### How it is spelled

`ModuleDeclaration` takes a fourth tuple, `needs: N`, and intersects
`NeedsGate<I, P, N>` onto the options parameter — `unknown` when satisfied, so
the parameter type is untouched; an object with one required property when
not. **The property, rather than `StartGate`'s bare string, is what makes the
diagnostic name the port** (measured, both ways):

```
Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
  '{ provides: [...]; exports: [...]; }' but required in type
  '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
```

Two details in that type are load-bearing and both were measured after they
broke something:

- **The failure branch inlines its `Exclude`** rather than naming an
  `Undeclared<I, P, N>` alias. An alias prints as itself, unreduced, and the
  reader gets their own tuples back instead of the port.
- **The RETURN type inlines the same computation too**, for a different
  reason: declaration emit keeps a named alias unreduced, and the unreduced
  form names the imported modules' internal ports — TS2883/TS4023 on the first
  consumer that exports a composition root (`OrderApi` "cannot be named
  without a reference to 'OrderDatabase'"). The same wall is why there is no
  exported `Unmet` helper: a shaped module could not name it in a return type
  either, so the computation is inlined wherever it appears — there was such an
  export once, and its documented purpose was impossible to serve.

The channel itself is unchanged: `Needs` is still what the module genuinely
owes, computed, not what it declared. Declaring a port nothing owes is inert —
it does not manufacture an obligation for a root to discharge
(`module.test-d.ts`, _"declaring a need nothing owes is inert"_).

### `Scope` is the one exemption, and it is forced

Nothing can provide `Scope` — a provider for it is a `WiringDefect` — so it is
never something an ancestor supplies; `Module.scoped` and `start` discharge it
by opening one. A resourceful module therefore declares nothing.

`Env` is **not** exempt, and exempting it was refused: the module that reads
the environment says `needs: [Env]` — `DatabaseModule`, `observability()`, each
starter — and from there it travels through importers without being restated,
up to the root `start` hands one to. Naming it at the feature is what a
`@Global` would have hidden; naming it at every hop was what made the first cut
of this gate noisy.

### The gate cannot be computed generically — and that is why the casts exist

The unmet-needs computation over a generic tuple `I` is a deferred conditional, and no object
literal satisfies one. So a **generic wrapper around `Module(name)`** — the
three starter sugars, `start`'s `Env` wrapper, `@btravstack/testing`'s
`tapped`, a factory like `makeAppModule` — cannot satisfy the gate at its own
definition site. The pattern, which is `runMain`'s discharged-signature cast
around `StartGate` one layer down:

1. **Re-declare the gate on the wrapper's own options**, over its augmented
   tuples, exactly as the sugars already re-declare `Exportable`. This is what
   makes the gate fire at the application's call — without it a root written
   with `HttpModule` would skip the check entirely.
2. **Assert past it at the inner call**, to a spelled-out object type
   intersected with the same `NeedsGate`. Not `as never`: that collapses the
   sugar's return type to `Module<never, never, never>` (measured). `start` and
   `tapped` may use `as never`, because both already cast their result.

### Which gate catches what

A starter's port — `HttpRouterPort`, the AMQP handlers port, the Temporal
activities port — is owed by the **starter**, which an application _imports_.
So those three are the KERNEL's gate, on the needs channel at `start`, not
di's declaration one, and the three `needs-gate.test-d.ts` negatives say so.
The declaration gate catches the other half: a module whose OWN provider reads
a port nothing here satisfies —
`examples/order-temporal-worker`'s `FulfillmentlessSlice`, whose `fulfillOrder`
piece names `StockService` and `ShippingService`. Both are pinned, side by side,
because conflating them is easy.

## Binding design rules

- **Comments in `src/` are regression guards, not decoration.** Many record
  decisions measured against a specific TypeScript version or a real failure mode
  (a diagnostic code, a variance bug, an unsoundness). Verify before
  "simplifying" them away.
- **Errors as values.** The `unthrown/*` oxlint rules are binding: no throwing
  outside a documented defect path. The existing `WiringDefect` throws each carry
  a targeted `oxlint-disable` with the rationale — new exceptions need the same.
- **One name per concept.** Resist convenience aliases. The surface is meant to
  stay small enough that the library can be "done"; contributions that sharpen
  the design beat ones that grow it.
