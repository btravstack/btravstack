# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@btravstack/di` — a module-based dependency-injection container for TypeScript. Ports are the vocabulary an application defines, providers bind them at one edge, modules declare `imports`/`exports`. Every wiring mistake the type system can catch is a compile error; what it can't (cycles, duplicate providers) surfaces as a defect before any factory runs. Nothing throws to callers: every fallible operation returns an [`unthrown`](https://github.com/btravstack/unthrown) `Result` (peer dependency).

pnpm workspace + turbo monorepo: `packages/di` is the single published package; `examples/*` are private consumer packages that double as end-to-end tests.

## Commands

Node `>=22.19` (root `engines` floor; `.node-version` pins the exact dev version), pnpm `11.7.0` (via `corepack enable`). `pnpm install` at the root. The published package separately claims `>=20` — see CONTRIBUTING.md for what each of the three numbers means.

The gate — every change must keep all of these green (CI runs the same set):

```sh
pnpm format --check   # oxfmt (run without --check to auto-fix)
pnpm lint             # oxlint (incl. unthrown/* rules)
pnpm typecheck        # tsc, incl. type-level *.test-d.ts tests
pnpm test             # vitest, library + examples
pnpm knip             # dead code / unused deps
pnpm build            # tsdown dual CJS/ESM + d.ts
```

Root scripts fan out through turbo; `test`/`typecheck` depend on `build`, so turbo builds first automatically. To scope to one package, run inside it, e.g.:

```sh
cd packages/di
pnpm vitest run src/build.spec.ts          # one test file
pnpm vitest run -t "releases in reverse"   # one test by name
pnpm test:types                            # type-level tests only (tsc -p tsconfig.test-d.json)
```

Commits follow Conventional Commits (commitlint via a lefthook `commit-msg` hook). User-facing changes need a changeset (`pnpm changeset`); internal-only changes (tests, CI, refactors) don't.

## Architecture

All runtime code lives in `packages/di/src`, one concept per file:

- **`port.ts`** — `Port("Id")` returns a phantom class; consumers write `class OrderRepository extends Port("OrderRepository")<Shape> {}`. Identity is nominal via module-private `unique symbol` brands (`ID`/`SERVICE`) — deliberately unexported so port instances are unforgeable. `Port.many` creates set ports (multiple providers contribute members); its runtime discriminant is the static `many: true` field, its type-level one the `[MANY]` brand. `Scope` is a phantom port (service shape `never`) that resourceful providers add to `Needs`.
- **`provider.ts`** — `Provider(Port)([deps], arm)` with a construction family of mutually exclusive option arms: `value` / `sync` / `make` (fallible, returns `Result`) / `class` / `acquire`+`release` (resourceful — puts `Scope` in `Needs`). Exclusivity is enforced by giving each arm the other keys as optional `never`. `Provider.member` contributes one member to a set port.
- **`module.ts`** — the `Module<Exports, E, Needs>` algebra. Three phantom channels with a deliberate variance rule: capability channels (`_exports`) are contravariant ("you may forget what you have"), obligation channels (`_error`, `_needs`) are covariant ("you may not forget what you owe"). Entry points hang off the `Module` const: `Module.build` (requires `Needs = never`), `Module.scoped` (opens a scope, excludes `Scope` from the check, guarantees close on every path), `Module.forkScope` (per-request scope seeded from a built parent `Context`). Unmet dependencies are compile errors via a conditional rest parameter — `[N] extends [never] ? [] : [error: "UNSATISFIED DEPENDENCIES", missing: N]`.
- **`build.ts`** — `flatten` (dedupe by provider reference), `plan` (levels providers for concurrent construction; detects cycles, duplicate providers, ordinary/set-port conflicts, providers for `Scope`, missing providers — all _before_ any factory runs), `run`, `runScoped`. Wiring bugs are thrown as `WiringDefect` inside a `.map` callback on purpose: unthrown converts the throw into its `Defect` channel, which is where wiring bugs (vs. modeled failures) belong.
- **`lifecycle.ts`** — constructs one level concurrently; collects `onStart` hooks, which fire only after the whole graph is built, in declaration order.
- **`context.ts`** — the built container: a flat map, `Context<R>.get(port)`. Internal `unsafeAdd`/`unsafeAddAll`/`unsafeKeys` are package-private, not exported from `index.ts`.
- **`scope.ts`** — `createScope`: finalisers run LIFO on close; a throwing finaliser is reported (via `onTeardownError`) and swallowed, never rethrown, so teardown always completes and never masks the original failure.
- **`index.ts`** — the deliberate public surface. `Scope` is exported as a _type only_ (the class value would let consumers provide or alias it); `PortClass`/`ManyPortClass` are exported solely so declaration emit works for consumers who export ports.

### Type-level tests

Behaviour that exists only at the type level (phantom-channel variance, arm exclusivity, `Scope` gating) is pinned in `src/*.test-d.ts` via `@ts-expect-error`, checked by `tsc --noEmit -p tsconfig.test-d.json` (part of `pnpm typecheck`). These files are excluded from the main tsc pass, from oxlint, and from lefthook's pre-commit lint. If you change a type-level guarantee, update the matching assertion. `src/type-assert.ts` (`Equal<A, B>`) is a test-only helper, excluded from knip.

### Two TypeScript versions

The catalog pins `typescript` 7.0.2 (what the repo builds with) and `typescript-consumer` (alias for 5.9.3 — what a consumer is realistically on). `examples/hexagonal-order-api`'s `typecheck` compiles declaration emit with _both_ and re-checks the emitted `.d.ts` under the consumer version; `src/emit-guards.ts` there is the fixture keeping the emitted declarations free of unnameable private types (the TS4020 class of bug).

### Examples are tests

`examples/*` exercise the library from a real consumer workspace (`workspace:*`, own `unthrown` dep since it's a peer). Their specs assert real behaviour (release order, set-port accumulation); compile-time-only guarantees live in their `*.test-d.ts`. Root `pnpm test`/`pnpm typecheck` include them.

## Binding design rules

- **Comments in `src/` are regression guards, not decoration.** Many record decisions measured against a specific TypeScript version or a real failure mode (a diagnostic code, a variance bug, an unsoundness). Verify before "simplifying" them away.
- **Errors as values.** The `unthrown/*` oxlint rules are binding: no throwing outside a documented defect path. The existing `WiringDefect` throws each carry a targeted `oxlint-disable` with the rationale — new exceptions need the same.
- **One name per concept.** Resist convenience aliases. The surface is meant to stay small enough that the library can be "done"; contributions that sharpen the design beat ones that grow it.
