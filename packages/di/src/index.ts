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
//
// `PortClass`/`ManyPortClass` are exported for declaration emit, not because a
// consumer is expected to write either by hand. `class OrderRepository extends
// Port("OrderRepository")<Shape> {}` — the pattern the README teaches — emits as
// `declare const OrderRepository_base: <the type of the heritage expression>`,
// and the emitter can only write that type using names the consumer can reach.
// With these two unexported it had none: it expanded the heritage expression
// down to `PortInstance`'s `[ID]`/`[SERVICE]` keys, which are module-private
// `unique symbol`s, and every consumer that *exported* a port failed with
// TS4020 ("has or is using private name 'ID'"). Naming the class types is the
// fix that costs least: the emitter stops at `PortClass<"OrderRepository">`
// (measured: 2,683 bytes of consumer declarations across the reproduction,
// against 3,545 when only the instance types are nameable and the emitter has
// to write the construct signature out).
//
// The symbols themselves stay unexported deliberately. They are what makes port
// identity nominal, and a consumer who can name `ID`/`SERVICE` can hand-write
// `{ [ID]: "Logger", [SERVICE]: Shape }` and pass it off as a `Logger` —
// measured, it type-checks. Exporting the class *types* grants no such thing:
// the brand keys stay unnameable, so `PortInstance` values remain unforgeable
// and `MemberOf`'s `[MANY]` discriminant stays unspoofable. `PortInstance` and
// the `[MANY]` intersection are never named here either — nothing in the emitted
// output needs them once the class types are reachable, and `emit-guards.ts` in
// `examples/hexagonal-order-api` is the fixture that keeps that true.
export type { AnyPort, ManyPortClass, PortClass, Scope, ServiceOf } from "./port.js";
export { Context } from "./context.js";
export { Provider } from "./provider.js";
export { Module } from "./module.js";
export type { ScopedOptions } from "./build.js";
