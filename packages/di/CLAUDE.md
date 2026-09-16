# packages/di

The container. The root `CLAUDE.md` owns the framework's thesis and the
conventions, and this file holds what only matters when you are working under
`packages/di/`. Keep it in sync with the code in the same commit.

`@btravstack/core` peers on this package and the arrow never runs the other
way: `packages/di` must never import from another workspace package.

## Architecture

All runtime code lives in `packages/di/src`, one concept per file:

- **`port.ts`** — `Port`, `Port.many` and the type-only `Scope` are
  `docs/reference/di/ports.md`'s. The brands (`ID`, `SERVICE`, `[MANY]`) stay
  module-private `unique symbol`s, so a port instance cannot be forged.

  Set ports were removed in `38d85f7` and restored for health checks. The removal's
  reason was that an audit "found no consumer in any of the eight packages or
  ten examples" — true when written, and since expired: a starter that declares
  a health check and a kernel that collects every one is exactly this shape,
  and it is the second request of the kind (auto-registered OTel
  instrumentation was the first). The levelling cost the removal cited is real
  and is back: `plan` keys `placed` by provider IDENTITY and compares placed
  counts against member totals, because keyed by bare `portId` the first member
  to land would drop its not-yet-placed siblings.

- **`provider.ts`** — the construction arms, the `inject` record and
  `Provider.member` are `docs/reference/di/providers.md`'s. Arm exclusivity is
  enforced by giving each arm the other keys as optional `never`.

  **`inject` rides in the same options object, and it is REQUIRED** (issue
  #227). One signature, one runtime path reading one key: the two overloads
  discriminated by argument count are gone, and with them the comment
  explaining that arity had to do the discriminating because a deps record and
  an options object are both non-array objects. Required is the load-bearing
  half — an optional `inject` degrades silently, since excess-property checking
  does not reject a mistyped `injec:` key inside the arm union, so a typo would
  become a no-deps provider and surface later as di's unmet-dependency defect
  instead of at the call. Required, the diagnostic names the property:
  `Property 'inject' is missing in type '{ injec: …; sync: … }'`. The price is
  that a provider declaring no dependencies spells `inject: {}` — the common
  shape in specs and fixtures, and paid deliberately.

  **The keyed form costs point-free, and that is accepted rather than a
  formatting accident.** `Provider(OrderRepository)([Database], { sync:
prismaOrderRepository })` handed the factory straight to `sync`; the same
  provider now has to spell `{ inject: { db: OrderDatabase }, sync: ({ db }) =>
prismaOrderRepository(db) }` — an adapter factory takes the client, not a
  record, so the wrapper arrow is unavoidable. That is inherent to naming
  dependencies:
  a name only exists at a call site if something writes it. One shape was the
  decision (the library is experimental and two spellings of one idea is the
  thing it declines to ship), so this is its price, not a bug to route around.
  Do not reintroduce a positional arm to recover it — measured at issue #227,
  there are **five** pure pass-through providers in all production code, four
  of them single-dependency, and the cheaper fix if the arrow grates is those
  five adapter factories taking `{ db }` instead of `db`.

- **`module.ts`** — the `Module<Exports, E, Needs>` algebra: its option lists,
  channels and variance rule are `docs/reference/di/modules.md`'s, and the
  entry points hanging off the `Module` const are
  `docs/reference/di/entry-points.md`'s. Unmet dependencies are compile errors
  via `DependencyGate`, a
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

  **A fork may be seeded.** `forkScope(parent, module, use, { seed: [[Port, value]] })`
  supplies per-scope values from outside the module tree; the planner treats a
  seeded port as provided, the way it treats the parent's services, so a module
  that `needs` a seeded port is accepted at the call and refused without the
  seed. The seeded value's type is the port's service, checked at the entry.
  `DependencyGate` is exported for the one consumer that wraps `forkScope`, the
  kernel, so it can state the same gate without re-declaring it.

  `needs` is the fourth tuple and the subject of **Module visibility** below:
  what this module expects a composition root to supply, named. Anything it
  owes and did not name is refused at the `Module(name)({...})` call by
  `NeedsGate`, which rides an intersection on the options parameter. What
  `exports` accepts is `docs/reference/di/modules.md`'s.

- **`build.ts`** — `flatten` (dedupe by provider reference), `plan` (levels
  providers for concurrent construction; detects cycles, duplicate providers,
  ordinary/set-port conflicts, providers for `Scope`, missing providers — all
  _before_ any factory runs; its first act is `resolveOverrides`, which
  substitutes each override IN ITS BASE'S POSITION — so the base is never
  levelled or constructed and declaration order, which error determinism and
  `onStart` ordering rely on, is untouched (pinned by `build.spec.ts`'s
  in-place test) — and throws the two override defects — "nothing to
  override", the drift gate a fixture gets, and "two overrides registered" —
  on the same pre-construction channel), `run`, `runScoped`. Wiring bugs are thrown as
  `WiringDefect` inside a `.map` callback on purpose: unthrown converts the throw
  into its `Defect` channel, which is where wiring bugs (vs. modeled failures)
  belong.
- **`index.ts`** — the deliberate public surface. `Scope` is exported as a _type
  only_ (the class value would let consumers provide or alias it);
  `PortClass`/`ManyPortClass` are exported so declaration emit **names** what
  a consumer's exported port extends. Not so it works at all — measured, and the earlier
  claim that it was load-bearing for correctness was wrong: with the export
  removed, `examples/di-hexagonal`'s emit gate still passes, because
  the emitter falls back to inlining the structural shape
  (`{ new <Service>(): PortInstance<Id, Service>; readonly portId: Id }`)
  and that compiles. What the export buys is that the blob stays out of every
  consumer's `.d.ts`, replaced by `import("@btravstack/di").PortClass<"Env">`.
  Keep it for that, and do not "verify" it by deleting it and watching the
  gate stay green — the gate is answering a different question.

  `PortInstance` and `PortClassOf` (`docs/reference/di/ports.md`) give a
  provider on a helper-minted port — `Config.provider("RelayConfig")(schema)`,
  or a starter's fixed port such as the one `api.OrpcRouter(contract)(…)`
  targets, `api` being `defineHttp`'s binding — a nameable declared type: the
  class expression `class extends Port(id)<S> {}` is anonymous, and a consumer
  exporting such a provider fails declaration emit with TS4023 (measured). The
  typed `provider.port` is `docs/reference/di/providers.md`'s. `AnyModule`,
  `AnyProvider`, `Exportable` and `NeedsGate` are exported for a starter's
  shaped module, as `docs/reference/di/modules.md` states. Spelling the shaped
  module's return type again in the sugar through a named generic alias was
  tried and removed: declaration emit keeps such an alias unreduced and cannot
  name imported modules' internal ports — TS2883 on the first consumer.
  `ModuleDeclaration`'s own return type stays inline for the same reason.

### The one example that came with it

`examples/di-hexagonal` is the one that survived the merge, on the
declaration-emit guard the root `CLAUDE.md` describes. If a set-port or
forked-scope example is ever wanted again, write it from `src/many.spec.ts`
and `src/fork.spec.ts` rather than restoring a workspace whose tests were
duplicates.

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

```text
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

```text
Property '"UNDECLARED NEEDS — name it in `needs` (a slice), or import/provide it (a root)"' is missing in type
  '{ provides: [...]; exports: [...]; }' but required in type
  '{ readonly "UNDECLARED NEEDS — name it in `needs` (a slice), or import/provide it (a root)": Logger; }'.
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

A starter's port — `OrpcRouterPort`, the AMQP handlers port, the Temporal
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
- **One name per concept.** Resist convenience aliases. The surface is meant to
  stay small enough that the library can be "done"; contributions that sharpen
  the design beat ones that grow it.
