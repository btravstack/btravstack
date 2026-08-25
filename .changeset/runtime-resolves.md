---
"@btravstack/contract": minor
"@btravstack/di": minor
"@btravstack/config": minor
"@btravstack/core": minor
"@btravstack/testing": minor
"@btravstack/observability": minor
"@btravstack/http-server": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
---

`Runtime.needs` is `Runtime.resolves`

Two different `needs` in one framework was one too many. di's `Module` has a
`needs` — what a composition root supplies it — and the kernel's `Runtime` had
one too, meaning something else entirely: the ports the runtime reads back out
of the built application context. They never appear in the same object, which
is exactly why the collision was easy to miss and easy to misread.

```ts
const runtime: Runtime<typeof Clock> = {
  name: "ticker",
  resolves: [Clock],
  start: (host) => OkAsync(serving),
};
```

The type parameter is `Resolves` rather than `Needs` throughout —
`Runtime<Resolves, Info>`, `RuntimeHost<Resolves>`, `RunUnit<Resolves>` — and
`start`'s gate sentence follows:
`"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`.

Every shipped runtime declares `resolves: []`, so an application that composes
`http()` / `temporal()` / `amqp()` and never writes a runtime by hand is
unaffected. A **hand-rolled** runtime renames one field.

The array is still never read at run time — it exists so `Resolves` is
inferable from the value, and `start`'s gate checks it against the module's
exports.
