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
  deliberately unexported so port instances are unforgeable. `Port.many` creates
  set ports (multiple providers contribute members); its runtime discriminant is
  the static `many: true` field, its type-level one the `[MANY]` brand. `Scope`
  is a phantom port (service shape `never`) that resourceful providers add to
  `Needs`.
- **`provider.ts`** — `Provider(Port)([deps], arm)` with a construction family of
  mutually exclusive option arms: `value` / `sync` / `make` (fallible, returns
  `Result`) / `class` / `acquire`+`release` (resourceful — puts `Scope` in
  `Needs`). Exclusivity is enforced by giving each arm the other keys as optional
  `never`. `Provider.member` contributes one member to a set port.
- **`module.ts`** — the `Module<Exports, E, Needs>` algebra. Three phantom
  channels with a deliberate variance rule: capability channels (`_exports`) are
  contravariant ("you may forget what you have"), obligation channels (`_error`,
  `_needs`) are covariant ("you may not forget what you owe"). Entry points hang
  off the `Module` const: `Module.build` (requires `Needs = never`),
  `Module.scoped` (opens a scope, excludes `Scope` from the check, guarantees
  close on every path), `Module.forkScope` (per-request scope seeded from a built
  parent `Context`). Unmet dependencies are compile errors via a conditional rest
  parameter — `[N] extends [never] ? [] : [error: "UNSATISFIED DEPENDENCIES",
missing: N]`.
- **`build.ts`** — `flatten` (dedupe by provider reference), `plan` (levels
  providers for concurrent construction; detects cycles, duplicate providers,
  ordinary/set-port conflicts, providers for `Scope`, missing providers — all
  _before_ any factory runs), `run`, `runScoped`. Wiring bugs are thrown as
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
  `PortClass`/`ManyPortClass` are exported solely so declaration emit works for
  consumers who export ports; `PortInstance` and **`PortClassOf<Id, Service>`**
  (`{ portId: Id; new (): PortInstance<Id, Service> }`, both types only) so a
  provider over a port minted inside a helper — `Config.provider("RelayConfig")(schema)`,
  `HttpRouter(contract)("OrderRouter")(deps, { sync })` — has a nameable
  declared type when a consumer exports it: the class expression
  `class extends Port(id)<S> {}` has an anonymous type declaration emit cannot
  name across packages (TS4023, measured), `PortClassOf` is its nameable
  spelling, and naming the instance type forges nothing (the brand keys stay
  private). `Provider(port)(deps, arm)`'s return type is `Provider<P, E, N> &
{ readonly port: typeof port }` — the provider carries its port class typed,
  so `provider.port` is what a dependent lists in its deps and what a starter
  reads the port off; purely additive. `AnyModule`, `AnyProvider` and
  `Exportable` are exported so a package offering a **shaped module** (a
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
because `many.spec.ts` and `fork.spec.ts` already pin what they asserted (and
`order-api` forks a real per-request scope besides). If a set-port or
forked-scope example is ever wanted again, write it from those specs rather than
restoring a workspace whose tests were duplicates.

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
