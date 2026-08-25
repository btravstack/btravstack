export { Port } from "./port.js";
// `Scope` is a TYPE-only export: every legitimate consumer use is a type
// position, and the value is the hazard — `Provider(Scope)(…)` registers a
// provider for the phantom, and `const widened: AnyPort = Scope` defeats any
// type-level guard. `plan()`'s runtime `portId` check stays as defence in depth.
//
// `PortClass` is exported for declaration emit, not to be written by hand:
// without it the emitter expands a port's heritage expression down to
// `PortInstance`'s module-private `unique symbol` keys, and every consumer that
// exported a port failed TS4020. The symbols stay unexported, because a
// consumer that can name them can hand-write a port instance and forge one;
// naming the class or instance TYPE forges nothing.
export type { AnyPort, PortClass, PortClassOf, PortInstance, Scope, ServiceOf } from "./port.js";
export { Context } from "./context.js";
export { Provider } from "./provider.js";
// Test-harness-facing: `@btravstack/testing`'s `overridden` is the intended
// caller. Production composition swaps an adapter by composing a different
// module.
export { overrideProvider } from "./provider.js";
export { Module } from "./module.js";
// Exported so a package offering a SHAPED module (a starter's sugar) can
// constrain its own tuples the way `Module(name)` does and hand them to
// `Module(name)` itself — whose return type is then the sugar's, spelled once.
export type { AnyModule, AnyProvider, Exportable, NeedsGate } from "./module.js";
export type { ScopedOptions } from "./build.js";
