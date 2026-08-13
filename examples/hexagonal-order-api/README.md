# hexagonal-order-api

The core story: an application layer that names its own ports and never
mentions an adapter, a persistence layer with a private connection pool and a
public repository, and a composition root generic enough to build the same
application against a production adapter or an in-memory one.

```sh
pnpm --filter @btravstack/di-example-hexagonal-order-api test
pnpm --filter @btravstack/di-example-hexagonal-order-api typecheck
```

## What it shows

`src/index.ts`, top to bottom:

- **Ports named by the domain, never by an adapter.** `OrderRepository` and
  `GetOrder` are declared once, by what the application needs.
  `GetOrderInteractor` depends only on `ServiceOf<OrderRepository>` and never
  imports an adapter module — production or in-memory.
- **A private internal beside a public surface.** `Persistence`'s `Pool` — a
  real connection, acquired with `acquire`/`release` — is never listed in
  that module's `exports`; `OrderRepository` is the only port it makes
  visible. The built context is a single flat runtime map (there is nowhere
  else to put a service), so `Pool` really is present in it — `exports`
  withholds the _type_ that would let a caller name it, not the entry
  itself. `src/index.test-d.ts` pins exactly that with a `@ts-expect-error`.
- **One composition seam, two adapters.** `makeAppModule` is generic in the
  persistence module's own `E`/`Needs`, so one application module wires up
  unchanged against `makePersistenceModule()` (resourceful, needs `Scope`)
  or `InMemoryPersistenceModule` (nothing to release, `Needs` collapses to
  `never`).

## The two entry points, forced by the type system

`Pool`'s `acquire`/`release` puts `Scope` in `Persistence`'s `Needs`, which
propagates through `makeAppModule` to anything built from it. Building that
graph with `Module.build` is a compile error, not a runtime leak — the
call's arity gate (the "UNSATISFIED DEPENDENCIES" rest parameter every unmet
requirement produces) rejects it before anything runs. `src/index.test-d.ts`
pins that with a `@ts-expect-error` of its own, right next to the privacy
one. `Module.scoped` is the one entry point that opens a scope and
discharges `Scope` — used in `src/index.spec.ts` against the production
adapter, closing the pool on every path out.

`InMemoryPersistenceModule` has nothing resourceful, so `makeAppModule`
applied to it has `Needs = never` — `Module.build` accepts it directly, no
scope required.

## What the spec proves

`src/index.spec.ts` builds both graphs and calls `GetOrder.execute` through
each: the production graph resolves against the pool and releases it
cleanly (no teardown errors reported), a missing id comes back as a modeled
`OrderNotFound` — never an exception — and the in-memory graph resolves
without ever touching `Module.scoped`. `src/index.test-d.ts` is the
compile-time half; see its own header for why those two assertions live in
their own file rather than a fourth `test()` here — asserting `Pool`'s
runtime absence would assert something false, since the flat context
genuinely holds it.
