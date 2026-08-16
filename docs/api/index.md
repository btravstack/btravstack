---
title: API reference
description: The generated reference for every published package — each exported symbol, its signature and its TSDoc.
---

# API reference

Generated from the source with [TypeDoc](https://typedoc.org/) at build time —
every exported symbol, with its signature and TSDoc. One page per package,
following the dependency direction: `di` → `config` → `core`, then the test
harness and the three starters on top of `core`.

- **[`@btravstack/di`](/api/di/)** — `Port` (and `Port.many`), `Provider`,
  `Module` (`Module.scoped`, `Module.forkScope`), `Context`, and the type
  names the surface carries: `AnyPort`, `ServiceOf`, `Scope`, `PortClass`,
  `ManyPortClass`, `PortClassOf`, `PortInstance`, `AnyModule`, `AnyProvider`,
  `Exportable`, `ScopedOptions`.
- **[`@btravstack/config`](/api/config/)** — `Config` (`string`, `integer`,
  `port`, `pinned`, `object`, `provider`), the `Env` port, the errors
  `ConfigInvalid` and `ConfigFieldInvalid`, and the types `ConfigField`,
  `ConfigIssue`, `ConfigSchema`, `Environment`.
- **[`@btravstack/core`](/api/core/)** — one entry point: `start`,
  `runMain`, `RuntimePort`, `RuntimeStartFailed`, `currentUnit`,
  `systemClock`, `stderrSink`, and the types `StartOptions`, `StartGate`,
  `RunningApp`, `ExitReport`, `TeardownError`, `DrainReport`, `Runtime`,
  `RuntimeHost`, `RunUnit`, `Serving`, `RuntimeInfoOf`, `UnitMeta`,
  `UnitRecord`, `UnitRegistry`, `UnitWork`, `Clock`, `Phase`, `KernelEvent`,
  `EventSink`.
- **[`@btravstack/testing`](/api/testing/)** — `bootFixture`, `tapped`,
  `withApp`, `testRuntime`, `TestRuntimePort`, `createFakeClock`, and the
  types `Boot`, `BootDefaults`, `ServicesOf`, `TestRuntime`,
  `TestRuntimeInfo`, `SubmittedUnit`, `FakeClock`.
- **[`@btravstack/http`](/api/http/)** — `HttpModule`, `HttpRouter`, `http`,
  the ports `HttpRuntime` and `HttpConfig`, and the types `HttpModuleOptions`,
  `HttpOptions`, `HttpInfo`.
- **[`@btravstack/temporal`](/api/temporal/)** — `TemporalModule`,
  `TemporalActivities`, `temporal`, the ports `TemporalRuntime`,
  `TemporalConfig` and `TemporalConnection`, the error `TemporalUnreachable`,
  and the types `TemporalModuleOptions`, `TemporalOptions`, `TemporalInfo`,
  `WorkflowSource`.
- **[`@btravstack/amqp`](/api/amqp/)** — `AmqpModule`, `AmqpHandlers`, `amqp`,
  the ports `AmqpRuntime` and `AmqpConfig`, and the types `AmqpModuleOptions`,
  `AmqpOptions`, `AmqpInfo`.

::: tip Looking for prose?
The generated pages document _signatures_. For what each package is **for**,
with its install line and worked examples, read
[Packages and install](/reference/packages) and the hand-written reference
under it; for _why_ the surface is shaped this way, read
[Why start?](/explanation/why-start).
:::

## The shape of the surface

An application imports from few places, and each import list stays short
because operations hang off the values by convention — `Port.many`,
`Module.scoped`, `Config.provider`:

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { Config, Env } from "@btravstack/config";
import { runMain, start } from "@btravstack/core";
import { HttpModule, HttpRouter } from "@btravstack/http";
```

`Scope` is a **type-only** export of `di`, and `PortClass`, `ManyPortClass`,
`PortClassOf` and `PortInstance` exist for declaration emit — a consumer that
exports a port or a minted provider needs the emitter to be able to name its
type — not for hand-written code. `RuntimeInstance`, `RuntimeOf` and
`RuntimeNeedsOf` are internal to `core` and deliberately absent from its
page. Everything else — the build pipeline, the lifecycle state machine, the
unit registry's internals — is implementation detail, not exported.
