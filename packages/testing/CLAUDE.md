# packages/testing

The test harness's public surface. The root `CLAUDE.md` is the authoritative
spec; this file holds what only matters under `packages/testing/`. Keep it in
sync with the code and `README.md` in the same commit — the package ships no
`docs-examples.test-d.ts` (the kernel's compiles the `testRuntime` /
`createFakeClock` samples; the README's `bootFixture` sample was
compiled and run as a scratch spec in `examples/order-api` when written).

It is `@nestjs/testing`'s shape: a package of its own that peers on the
kernel, so a production bundle never pulls the fakes in — the effect
`@btravstack/core/testing` used to get from a second entry point, without a
kernel that ships its own doubles.

## Public surface

- **`bootFixture(defaults?)`** — a `test.extend` fixture: `async ({}, use) =>
Promise<void>` handing `use` a **`Boot`** — `start`'s own signature and
  phantom `StartGate` minus `signals` — and stopping every app it started once
  `use` returns, on every exit path. It is a **plain function, not a vitest
  subpath**: vitest's fixture protocol is `(ctx, use) => Promise<void>`, so
  the package imports nothing from vitest and lists no vitest peer; a
  consumer hands the result to its own `test.extend`. Defaults, in
  precedence order: `signals: false` always (last spread, uncancellable —
  process-wide handlers would fight across a file); then a call's own
  options; then `defaults` (**`BootDefaults`** = `StartOptions` minus
  `signals` and `unit` — a unit module is a call's business); then
  `probes: false`, `preDrainDelayMs: 0`, a silent `onEvent`. So `boot(m, {
probes: { port: 0 } })` binds a probe server over the default. Teardown
  is **Defect-only**: `stop()`, `await exited`, and a
  `Defect` is rethrown (`exit.cause`) so a shutdown that blew up fails the
  test even when the test never read `exited`; a modeled `Err` passes
  through, since a startup failure is an outcome a test may be asserting —
  which is why `serveBroken`-style fixtures in the starters assert their
  `Err` themselves. Apps are stopped in the order booted, sequentially. The
  boot body forwards through a discharged-signature cast — the same move
  the kernel makes on `start` — because the gate is proven at
  each `boot` call site and invisible in the fixture body.
- **`tapped(module, ports)`** → `{ module, services() }`; **`ServicesOf<P>`**
  is the tuple `services()` answers. `start` hands the application context to
  the runtime alone, so a test that wants the very `Logger` the use cases
  write to has no `ctx.get`; `tapped` composes `Module("Tapped")({ imports:
[module], provides: [tap], exports: [module] })` where `tap` is
  `Provider(Tap)(ports, { sync })` remembering what it was built with — di
  builds every provider in the graph, exported or not, which is what makes it
  work with `Tap` never exported. The returned module is cast back to
  `Module<X, E, N>`: it exports exactly what `module` exports, so the kernel
  still finds the runtime and the gates see nothing new. **`Tap` is
  `Port("@btravstack/testing/Tap")` declared once**, module-private: two `tapped` modules in one
  graph are di's duplicate-provider defect at build, and one tap per
  application is the case. **The gate** is a phantom rest tuple —
  `[Exclude<InstanceType<P[number]>, X>] extends [never] ? [] : [error: "NOT
EXPORTED", missing]` — refusing at the call site a port `module` does not
  export: an application-scope service is the only thing there is to tap.
  **`services()` is loud**: it throws (`unthrown/no-throw` disabled with a
  reason) when read before the graph is built — reading a tap nobody booted
  is a bug in the test, not a modeled outcome, and an `undefined` a careless
  assertion could swallow is worse than a throw. Read it after
  `runtimeInfo()` (or `untilStarted()`) resolves.
- **`testRuntime(name?)`** / **`TestRuntimePort`** / **`TestRuntime`** /
  **`TestRuntimeInfo`** / **`SubmittedUnit`** — an in-memory
  `Runtime<never, TestRuntimeInfo>` plus `started()`, `untilStarted()` (an
  `AsyncResult<void, never>`), `accepting()`, `serving()`, `submit<T, E>()`,
  and **`module`** — a `Module<TestRuntimePort, never, never>` providing
  **this** object on `TestRuntimePort` (declared over `RuntimePort`), which
  is how a test composition gets a runtime: import `runtime.module`, export
  `TestRuntimePort`. A wrapper built by spreading (`{ ...runtime, start }`)
  copies the module too, so its module still boots the inner runtime — a
  wrapper provides itself with a module of its own (`test-fixtures.ts`'s
  `runtimeModule(runtime)`, here and in the kernel). It publishes `{ name }`
  on `Serving.info` — the one thing an in-memory runtime genuinely knows about
  itself — so the kernel's `runtimeInfo()` channel is exercised end to end.
  `submit` returns a `SubmittedUnit` (`settle`, `result`, `signal`) so a test
  can hold a unit open across a drain; `signal` is **forwarded** through an
  `AbortController` rather than captured, because with a `unit` module the
  kernel runs the work only once the fork is built, and a captured signal
  would be `undefined` for a caller reading it right after `submit()`. It
  deliberately **ignores** the `Serving.drain(signal)` deadline — `drain`
  flips `accepting` and returns at once — which is what makes the kernel's
  abort tests tests of the kernel, not of the fake. `serving()` and
  `submit()` and **`inUnit()`** are its three misuse guards: each throws
  (`no-throw` disabled with a reason) when the runtime was never started or is
  no longer accepting — a bug in the test, loud on purpose.
  **`inUnit(meta, work)`** → `Promise<T>` runs `work` INSIDE one unit and
  answers what it answered: the writer half of `currentUnit()`, which the
  kernel deliberately does not export — only a runtime opens a unit, and in a
  test this runtime is the one that does. `meta` is a `Partial<UnitMeta>`
  filling in what the caller cares about (`tenantId`, a `traceId`); `kind`
  and `id` are **defaults** it is spread over, so a spec may pin either. The
  default `id` is unique per call — the obligation a real runtime carries —
  and overriding it costs only a shared `traceId`, since `UnitRecord.unitId`
  is minted by the kernel and is unique whatever `meta` says. The bare
  `Promise` is the **fourth** documented exception to thesis 6, on
  `bootFixture`'s reasoning: `work` is the test body. It is the
  complement of `submit()`, not a variant: `submit` hands back a unit the test
  settles from **outside**, for asserting on the drain, while `inUnit` is for
  asserting on what code running **inside** a unit read. The outcome travels
  back out of the unit rather than being captured by a closure, and a throw
  from `work` is **rethrown** — folding a failing `expect` into the unit's
  `Result` would make it a `Defect` a caller can forget to unwrap, which is a
  green test that asserted nothing.
- **`unitFixture()`** / **`InUnit`** — a `test.extend` fixture over
  `testRuntime` + `bootFixture`, for testing the code that **reads** the
  ambient record: a database adapter stamping `tenantId` on a query, a logger
  correlating on `traceId`, anything reaching for `currentUnit()`. It hands
  the test an `InUnit` — `<T>(meta: Partial<UnitMeta>, work: () => T |
Promise<T>) => Promise<T>` — and boots one in-memory app per test, stopped
  with it. The unit is the **kernel's own**, opened through `RuntimeHost.run`
  exactly as a transport would open one, not an `AsyncLocalStorage` the
  harness runs beside it: a fabricated record could drift from the one
  `units.ts` mints, and the whole value of testing an ambient reader is that
  it saw the real thing. `work` must not outlive the call — a unit is closed
  the instant its work settles, which is the kernel's own contract, so a
  promise started inside one and awaited outside is reading a record that has
  already gone.
  `examples/order-infrastructure`'s `asTenant` fixture is the shape a consumer
  builds on it: `(work) => inUnit({ tenantId: tenant }, work)`.
- **`createFakeClock(start?)`** / **`FakeClock`** — a `Clock` whose time moves
  only on `advance(ms)` (an `AsyncResult<void, never>`), which **brackets
  itself with a real macrotask at each end** (`setTimeout(resolve, 0)`) — the
  only real timing it uses — so a test can trigger a shutdown and advance in
  the very next statement without racing the kernel arming its next sleep.
  `sleep` resolves at once for `ms <= 0` or an already-aborted signal, and an
  abort cuts a pending sleep short and **forgets** it (advancing past its
  deadline must not resolve it twice) — the kernel's second-SIGTERM `skip`
  signal is what that path exists for.
- Peer dependencies: `@btravstack/core`, `@btravstack/config` (`Env`, in
  `Boot`'s `Module<X, E, Scope | Env>`), `@btravstack/di`,
  `unthrown`. Nothing else, and no `vitest`.

## Tests

Six spec files, 100% lines/functions (`test-fixtures.ts` excluded, per the
Test conventions). `test-fixtures.ts` exports the extended `it` — the
package's own `bootFixture` **and `unitFixture`**, dogfooded — plus
`greetingApp()` (an in-memory runtime next to a `Greeting`, both exported:
what `tapped` and `boot` are exercised against) and `runtimeModule(runtime)`.

- `boot-fixture.spec.ts` (5): the defaults read back off a booted app
  (`serving`, no probe port), a call's `probes: { port: 0 }` beating the
  default, a shutdown defect failing the test and a modeled startup `Err`
  passing (both driving the fixture by hand, `fixture({}, use)`), a call's
  `onEvent` beating the fixture's.
- `tapped.spec.ts` (2): the very service instance the graph holds, and the
  loud read before boot.
- `test-runtime.spec.ts` (8): started, work routed through the host, the three
  misuse guards (`inUnit`'s among them), the abort forwarded when the host opens units already aborted
  and when it fires while the unit is open, `accepting()` before/after the
  drain. Its `hostFor` stub **replaces the kernel's registry** — a
  `RuntimeHost` counting open units and handing each an `AbortSignal` in a
  dozen lines — so the runtime is tested without booting a kernel around it.
- `unit-fixture.spec.ts` (6): the record is the kernel's own, the caller's
  `tenantId` / `traceId` travel on it, each call is its own unit, the work's
  value comes straight back, a throw is rethrown so a failing assertion reaches
  the runner, and nothing is left ambient once the work has settled.
- `fake-clock.spec.ts` (6): starts at 0 / at the supplied instant, a sleep
  pending until its deadline, non-positive sleep, already-aborted signal, an
  abort cutting a sleep short and forgetting it.

The kernel invariants these hold — _"No `Result` is produced and left
unexamined"_ and the abort-from-`registry.abortAll()` one — are listed in
`packages/core/CLAUDE.md`, pointing here.

## How the kernel's own specs reach this package

`@btravstack/core`'s specs use `bootFixture`, `testRuntime` and `createFakeClock`,
and this package peers on `@btravstack/core`. Listing it as a devDependency of
core would be a **package-graph cycle turbo refuses**, so it is not one:

- `packages/core/tsconfig.json` maps `paths: { "@btravstack/testing":
["../testing/dist/index.d.mts"] }` for the type checker (the built
  declarations — the source would fall outside core's `rootDir`);
  `tsconfig.build.json` (what `tsdown` compiles) empties `paths` and drops
  the spec files, so the published `dist` never sees it.
- `packages/core/vitest.config.ts` aliases `@btravstack/testing` to
  `../testing/src/index.ts` and `@btravstack/core` to `./src/index.ts` at run
  time — one kernel in play, and coverage measures what the specs run.
- `turbo.json`'s `@btravstack/core#typecheck` depends on
  `@btravstack/testing#build`, so the d.ts exists before core is type-checked
  (`test` and `build` need no edge: vitest reads the source, `tsdown` never
  sees the import).
- `knip.json`'s `packages/core` entry carries `ignoreDependencies:
["@btravstack/testing"]`, since the import resolves through neither
  `package.json`.
