---
"@btravstack/testing": minor
"@btravstack/core": minor
---

**`@btravstack/testing`** — the test harness is a package of its own, the
way `@nestjs/testing` is, and `@btravstack/core/testing` is gone (breaking,
unreleased). It ships what the kernel's entry point did — `testRuntime()` /
`TestRuntimePort`, `createFakeClock()`, `withApp()` — plus two things the
example suites had been hand-rolling in every `test-fixtures.ts`:

- **`bootFixture(defaults?)`** — a `test.extend` fixture handing the test a
  `boot(module, options?)` with a test's defaults baked in (`signals: false`
  always, `probes: false` unless a call asks for a port, `preDrainDelayMs: 0`,
  a silent `onEvent`), every application it started stopped when the test
  ends. Teardown mirrors `withApp`: a `Defect` on `exited` fails the test, a
  modeled `Err` passes through.
- **`tapped(module, [Port, …])`** — read services out of a booted application
  (`start` hands the context to the runtime alone). Returns `{ module,
services() }`; the gate refuses a port `module` does not export, and
  `services()` is loud before the graph is built.

The kernel's own specs, the three starters' and the three deployment
examples' fixtures now use it; core keeps no test double of its own.
