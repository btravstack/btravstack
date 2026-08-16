# packages/testing

The test harness's public surface. The root `CLAUDE.md` is the authoritative
spec; this file holds what only matters under `packages/testing/`. Keep it in
sync with the code and `README.md` in the same commit — the package ships no
`docs-examples.test-d.ts` (the kernel's compiles the `testRuntime` /
`createFakeClock` / `withApp` samples; the README's `bootFixture` sample was
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
  mirrors `withApp` **and is Defect-only**: `stop()`, `await exited`, and a
  `Defect` is rethrown (`exit.cause`) so a shutdown that blew up fails the
  test even when the test never read `exited`; a modeled `Err` passes
  through, since a startup failure is an outcome a test may be asserting —
  which is why `serveBroken`-style fixtures in the starters assert their
  `Err` themselves. Apps are stopped in the order booted, sequentially. The
  boot body forwards through a discharged-signature cast — the same move
  `withApp` and the kernel make on `start` — because the gate is proven at
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
- **`withApp(module, options, use)`** — start, hand to `use`, stop again
  whatever `use` does; the callback shape from before `bootFixture` existed,
  moved here unchanged. `signals` and `probes` are **forced off** whatever the
  caller passes; a test needing the real probe server calls `start` directly.
  It carries the same phantom gate as `start`, and is the one harness-shaped
  exception to the kernel's Thesis #6 (both it and `use` speak a bare
  `Promise`): `use` is the test body, a thrown assertion failure inside it
  must reach the test runner, and an `AsyncResult` never rejects — converting
  either side would turn a failing `expect` into a `Defect` a caller can
  forget to unwrap, i.e. a green test that asserted nothing; `A` is the test
  author's own type and carries no error channel, so the wrapper would add no
  information either. It **rethrows a `Defect`** on `exited` and only a
  `Defect`: the harness awaits `exited` to know the application stopped, and
  dropping that `Result` let a shutdown that blew up pass as a green test when
  `use` never read `exited`. A modeled `Err` is an outcome a test may be
  asserting, so it passes through. A failure thrown by `use` outranks both —
  it is held while the application is stopped and rethrown unchanged, so a
  shutdown defect can never mask the assertion that actually failed.
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
  `submit()` are its two misuse guards: each throws (`no-throw` disabled with
  a reason) when the runtime was never started or is no longer accepting — a
  bug in the test, loud on purpose.
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
  `Boot`'s and `withApp`'s `Module<X, E, Scope | Env>`), `@btravstack/di`,
  `unthrown`. Nothing else, and no `vitest`.

## Tests

Five spec files, 100% lines/functions (`test-fixtures.ts` excluded, per the
Test conventions). `test-fixtures.ts` exports the extended `it` — the
package's own `bootFixture`, dogfooded — plus `greetingApp()` (an in-memory
runtime next to a `Greeting`, both exported: what `tapped` and `boot` are
exercised against) and `runtimeModule(runtime)`.

- `boot-fixture.spec.ts` (5): the defaults read back off a booted app
  (`serving`, no probe port), a call's `probes: { port: 0 }` beating the
  default, a shutdown defect failing the test and a modeled startup `Err`
  passing (both driving the fixture by hand, `fixture({}, use)`), a call's
  `onEvent` beating the fixture's.
- `tapped.spec.ts` (2): the very service instance the graph holds, and the
  loud read before boot.
- `test-runtime.spec.ts` (7): started, work routed through the host, the two
  misuse guards, the abort forwarded when the host opens units already aborted
  and when it fires while the unit is open, `accepting()` before/after the
  drain. Its `hostFor` stub **replaces the kernel's registry** — a
  `RuntimeHost` counting open units and handing each an `AbortSignal` in a
  dozen lines — so the runtime is tested without booting a kernel around it.
- `fake-clock.spec.ts` (6): starts at 0 / at the supplied instant, a sleep
  pending until its deadline, non-positive sleep, already-aborted signal, an
  abort cutting a sleep short and forgetting it.
- `with-app.spec.ts` (3): a shutdown Defect `use` never looked at, `use`'s own
  failure winning over a shutdown Defect, a modeled `Err` passing through.
  `defectingOnStop` mints the defect the only documented way — a throw
  inside a combinator's throw-to-defect net — since `Defect` has no public
  constructor.

The kernel invariants these hold — _"No `Result` is produced and left
unexamined"_ and the abort-from-`registry.abortAll()` one — are listed in
`packages/core/CLAUDE.md`, pointing here.

## How the kernel's own specs reach this package

`@btravstack/core`'s specs use `testRuntime`, `createFakeClock` and `withApp`,
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
