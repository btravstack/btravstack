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
  `signals`; exported, like
  **`SubmittedUnit`**, because a documented parameter or return type a
  consumer cannot name is a surface gap, and the doc-samples signature gate
  is what found both); then
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
  `Provider(Tap)({ inject: ports, sync })` remembering what it was built with — di
  builds every provider in the graph, exported or not, which is what makes it
  work with `Tap` never exported. The returned module is cast back to
  `Module<X, E, N>`: it exports exactly what `module` exports, so the kernel
  still finds the runtime and the gates see nothing new. **`Tap` is
  `Port("@btravstack/testing/Tap")` declared once**, module-private: two `tapped` modules in one
  graph are di's duplicate-provider defect at build, and one tap per
  application is the case. **The gate** is `TapGate`, a marker intersected onto the
  `ports` parameter — `unknown` when every tapped port is exported, `{
readonly "NOT EXPORTED — tap only what the module exports": Missing }`
  otherwise, so the diagnostic ends on the port (measured; the conditional
  rest tuple it replaced printed only a bare arity line) — refusing at the
  call site a port `module` does not
  export: an application-scope service is the only thing there is to tap.
  **`overridden(module, overrides)`** is the decision issue #63 recorded: the
  real root with named providers substituted, riding di's `overrideProvider`
  (the container's one deliberately test-facing export). It exists because the
  measured cost of pure recomposition was four hand-maintained parallel roots
  in `examples/` mirroring the real ones with nothing tying the copies
  together — nothing can be layered over a graph that already provides
  `Logger`. The base provider is never constructed; an override the tree no
  longer backs is a `WiringDefect` ("nothing to override"), which turns fixture
  drift into a loud failure; an override's own deps resolve from the graph's
  internals and deliberately do not widen the returned `Needs` (checked at
  build by the missing-provider defect instead); and it replaces one PROVIDER,
  never a subsystem — the temporal fixture stays composed because its
  contract varies per test, and that line is stated in its own TSDoc.
  Production roots stay override-free by convention, restated in the root
  `CLAUDE.md`'s public-surface section. **`services()` is loud**: it throws (`unthrown/no-throw` disabled with a
  reason) when read before the graph is built — reading a tap nobody booted
  is a bug in the test, not a modeled outcome, and an `undefined` a careless
  assertion could swallow is worse than a throw. Read it after
  `runtimeInfo()` (or `untilStarted()`) resolves.
- **`testRuntime(name?, { unit? })`** / **`TestRuntimePort`** / **`TestRuntime`**
  / **`TestRuntimeInfo`** / **`TestRuntimeOptions`** / **`SubmittedUnit`** — an
  in-memory `Runtime<never, TestRuntimeInfo>` plus `started()`, `untilStarted()`
  (an `AsyncResult<void, never>`), `accepting()`, `serving()`, `host()`,
  `submit<T, E>()`, and **`module`** — a `Module<TestRuntimePort, never,
UnitNeedsOf<Unit>>` providing **this** object on `TestRuntimePort` (declared over
  `RuntimePort`), which is how a test composition gets a runtime: import
  `runtime.module`, export `TestRuntimePort`. A wrapper built by spreading
  (`{ ...runtime, start }`) copies the module too, so its module still boots
  the inner runtime — a wrapper provides itself with a module of its own
  (`test-fixtures.ts`'s `runtimeModule(runtime)`, here and in the kernel). It
  publishes `{ name }` on `Serving.info` — the one thing an in-memory runtime
  genuinely knows about itself — so the kernel's `runtimeInfo()` channel is
  exercised end to end. **`host()`** answers the `RuntimeHost` the kernel
  last called `start` with — loud (same rationale as `serving()`) before
  then — which is how a spec opens a fork of its own outside `submit`, the way
  `unit-module.spec.ts`'s "second fork is a defect" test does. **`unit`**
  (`TestRuntimeOptions`) is a module every submitted unit forks, with no seed,
  before its work runs — `submit`'s work callback is `unit === undefined ?
held : unitHost.fork(unit, []).flatMap(() => …)`, so `testRuntime` is what a
  spec composes to exercise the same `UnitHost.fork` path a real runtime
  drives, without booting one. **The bound module's needs are propagated**:
  `testRuntime<Unit extends AnyUnitModule | undefined = undefined>` threads
  `Unit` into `TestRuntime.module`'s Needs, so a composition that does not
  supply what the unit module owes is refused by `start`'s `UNSATISFIED
DEPENDENCIES` gate rather than by a `WiringDefect` on the first `submit()` —
  the same shape the three shipped starters carry, `| undefined = undefined`
  included (without that default `Needs` degrades to `unknown`).
  `AnyUnitModule`/`UnitNeedsOf` are not exported from `index.ts`, reached the
  same way `@btravstack/http-server`'s namesakes are. The fork call still
  carries `as never`: `AnyUnitModule` erases Needs to `unknown`, which
  `fork`'s own `DependencyGate` can never clear from inside a generic. `submit` returns a `SubmittedUnit` (`settle`,
  `result`, `signal`) so a test can hold a unit open across a drain; `signal`
  is **forwarded** through an `AbortController` rather than captured, because
  the work runs only once the fork is built (with a `unit` module bound), and
  a captured signal would be `undefined` for a caller reading it right after
  `submit()`. It deliberately **ignores** the `Serving.drain(signal)` deadline
  — `drain` flips `accepting` and returns at once — which is what makes the
  kernel's abort tests tests of the kernel, not of the fake. `serving()`,
  `host()` and `submit()` are its three misuse guards: each throws
  (`no-throw` disabled with a reason) when the runtime was never started or is
  no longer accepting — a bug in the test, loud on purpose.
- **`createFakeClock(start?)`** / **`FakeClock`** — a `Clock` whose time moves
  only on `advance(ms)` (an `AsyncResult<void, never>`), which **brackets
  itself with a real macrotask at each end** (`setTimeout(resolve, 0)`) — the
  only real timing it uses — so a test can trigger a shutdown and advance in
  the very next statement without racing the kernel arming its next sleep.
  `sleep` resolves at once for `ms <= 0` or an already-aborted signal, and an
  abort cuts a pending sleep short and **forgets** it (advancing past its
  deadline must not resolve it twice) — the kernel's second-SIGTERM `skip`
  signal is what that path exists for.
- **`localIssuer(options)`**, on the `@btravstack/testing/jwt` subpath —
  `LocalIssuerOptions` / `SignOptions` / `LocalIssuer` are its types. It mints
  one generated key pair, a `node:http` listener answering `{ keys: [jwk] }`
  on **any** path (`jwks`), and a `sign(claims?, options?)` closing over the
  private key — a real fetch against a real JWKS document, so rotation and
  caching under test are the verifying library's own behaviour rather than a
  double's. `kid` is fixed at `"k1"`; `algorithm` is asymmetric-only
  (`"RS256" | "RS384" | "RS512" | "ES256" | "ES384"`, the same list
  `@btravstack/http-server`'s `jwtVerifier` accepts) and defaults to `"RS256"`.
  `sign`'s `options` override the issuer, the audience and the expiry per
  call — `expiresIn: false` mints a token with no `exp` claim at all, for a
  test that wants an unexpiring or malformed token. `close()` stops the
  listener; nothing else needs tearing down.

  **It was promoted from `@btravstack/http-server`'s own private test
  fixture (`issuerOf` in that package's `__tests__/test-fixtures.ts`), not
  written fresh.** `@btravstack/http-server`'s own JWT authenticator fixture,
  `examples/order-api`'s specs and its dev-loop OIDC issuer all want the
  identical key pair, JWKS listener and signer — three consumers of one
  fixture is what makes it a package surface rather than a starter's private
  test helper. A real Keycloak or Dex container was considered and declined:
  either is another daemon on the shared `internal/test-infra` roster for a
  behaviour four lines of `jose` already cover exactly, and neither buys back
  anything this fixture's real fetch against a real JWKS does not already
  prove.

  **`sign` answers `AsyncResult<string, never>`, not a bare `Promise`** —
  `fromSafePromise` over `jose`'s own `SignJWT.sign`, because every async
  surface in this package does, and a `Promise` here would have been a fourth
  exception to that rule with no reason the other three (`runMain`,
  `UnitWork`'s caller-handler arm, `bootFixture`'s vitest fixture protocol)
  have. `close()` is the same call for the same reason.

  **A test that wants a shared issuer across a spec file uses a
  `{ scope: "file" }` fixture, not a per-test one.** Each `localIssuer` call
  generates a fresh key pair and binds a fresh listener, and a spec asserting
  the JWKS several times over does not need a new one per test — a file-scope
  fixture builds it once and tears it down once the file is done, which is
  the shape `src/__tests__/test-fixtures.ts`'s own `issuer` fixture is. A test
  that closes the issuer itself (or wants a different `algorithm`) mints its
  own instance instead of reaching for the shared one.

  **The subpath needs Node ≥22.12 under CommonJS.** `jose` is ESM-only, so
  the CJS build's `require("jose")` depends on `require(esm)`, which Node
  enables by default from 22.12. ESM consumers are unaffected on any Node 22,
  and so is every consumer that never imports `@btravstack/testing/jwt` —
  which is why this is stated here rather than paid for by raising the
  package's own `engines` floor, a breaking change for the many to serve the
  few.

- Peer dependencies: `@btravstack/core`, `@btravstack/config` (`Env`, in
  `Boot`'s `Module<X, E, Scope | Env>`), `@btravstack/di`, `unthrown`. `jose`
  is an **optional** peer behind the `/jwt` subpath, on the same protocol as
  `@btravstack/observability`'s `pino` and `@btravstack/http-server`'s own
  `jose` — a consumer that never imports the subpath installs nothing extra.
  Nothing else, and no `vitest`.

## Tests

Six spec files, 100% lines/functions (`test-fixtures.ts` excluded, per the
Test conventions). `test-fixtures.ts` exports the extended `it` — the
package's own `bootFixture`, dogfooded, and a file-scoped `issuer`
(`localIssuer`) — plus
`greetingApp()` (an in-memory runtime next to a `Greeting`, both exported:
what `tapped` and `boot` are exercised against) and `runtimeModule(runtime)`.

- `boot-fixture.spec.ts` (5): the defaults read back off a booted app
  (`serving`, no probe port), a call's `probes: { port: 0 }` beating the
  default, a shutdown defect failing the test and a modeled startup `Err`
  passing (both driving the fixture by hand, `fixture({}, use)`), a call's
  `onEvent` beating the fixture's.
- `tapped.spec.ts` (2): the very service instance the graph holds, and the
  loud read before boot.
- `test-runtime.spec.ts` (10): started, work routed through the host, the
  three misuse guards (`serving()`, `host()`, `submit()`), the abort forwarded
  when the host opens units already aborted and when it fires while the unit
  is open, `accepting()` before/after the drain, `host()` answering the
  `RuntimeHost` last started with, and a `unit`-bound runtime forking it
  before the work runs. Its `hostFor` stub **replaces the kernel's registry**
  — a `RuntimeHost` counting open units, handing each an `AbortSignal` and a
  real (if minimal) `UnitHost.fork` over `Module.forkScope`, in a few dozen
  lines — so the runtime is tested without booting a kernel around it.
- `fake-clock.spec.ts` (6): starts at 0 / at the supplied instant, a sleep
  pending until its deadline, non-positive sleep, already-aborted signal, an
  abort cutting a sleep short and forgetting it.
- `jwt.spec.ts` (6): the JWKS at the URL it answers, a signed token the JWKS
  verifies, issuer/audience/expiry overridden on request, the algorithm it
  was asked for, and closing split into two — `close()` answering `Ok`, and a
  fetch after closing rejecting.

The kernel invariants these hold — _"No `Result` is produced and left
unexamined"_ and the abort-from-`registry.abortAll()` one — are listed in
`packages/core/CLAUDE.md`, pointing here.

## How the kernel's own specs reach this package

`@btravstack/core`'s specs use `bootFixture`, `testRuntime` and `createFakeClock`,
and this package peers on `@btravstack/core`. Listing it as a devDependency of
core would be a **package-graph cycle turbo refuses**, so it is not one:

- `packages/core/tsconfig.json` maps `paths: { "@btravstack/testing":
["../testing/dist/index.d.mts"], "@btravstack/testing/jwt":
["../testing/dist/jwt.d.mts"] }` for the type checker (the built
  declarations — the source would fall outside core's `rootDir`); a doc
  sample naming a subpath needs its own entry here, which is how `/jwt`
  joined the map. `tsconfig.build.json` (what `tsdown` compiles) empties
  `paths` and drops the spec files, so the published `dist` never sees it.
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
