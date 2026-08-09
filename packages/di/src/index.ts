export { Port } from "./port.js";
// `Scope` is exported as a *type* only. Every legitimate consumer use is a
// type position — `Module<X, E, Scope>`, `Exclude<N, Scope>`, pinning a
// provider's `Needs` — and nothing outside this package has a reason for the
// class value. The two things the value enables are both the hazard:
// `Provider(Scope)(…)` registers a provider for the phantom, and `const
// widened: AnyPort = Scope` is the alias that defeats any type-level guard.
// Withholding the value removes the ordinary way in; `plan()`'s runtime
// `portId` check (`build.ts`) stays as defence in depth for the paths a
// type-only export cannot close (a hand-rolled port with the same id, or a
// consumer reaching past the index). Internal modules import the class from
// `./port.js` directly, as do the two tests that exist to prove the runtime
// check still fires (`scoped.spec.ts`).
export type { AnyPort, Scope, ServiceOf } from "./port.js";
export { Context } from "./context.js";
export { Provider } from "./provider.js";
export { Module } from "./module.js";
export type { ScopedOptions } from "./build.js";
