---
"@btravstack/core": minor
---

**Breaking.** The runtime is a service the module provides, not an option.
`StartOptions.runtime` is gone: `start(module, options?)`, `runMain(module,
options?, exit?)` and `withApp(module, options, use)` build the module,
resolve its runtime through the kernel's new **`RuntimePort`** — `Port("Runtime")`,
exported generic so a runtime package (or an application) declares its own
concrete port over it, `class HttpRuntime extends
RuntimePort<Runtime<never, HttpInfo>> {}` — and drive what they find. The kernel is DI
initialisation and lifecycle, nothing else; every runtime port shares one id,
which is how a graph holds exactly one.

The phantom gate grows a third arm: `NO RUNTIME` when the module exports no
runtime port, alongside `UNSATISFIED RUNTIME NEEDS` and `UNSATISFIED UNIT
NEEDS`. `Needs` and `Info` are read off the module (`RuntimeNeedsOf<X>`,
`RuntimeInfoOf<X>`, `RuntimeOf<X>`, `RuntimeInstance` are exported), so
`RunningApp<E, RuntimeInfoOf<X>>` types `runtimeInfo()` from the composition
alone.

`@btravstack/core/testing`: `testRuntime()` carries `.module`, a module
providing itself on the exported `TestRuntimePort` — import it next to the
module under test and export the port.
