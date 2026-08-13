# API reference

Generated from the source with [TypeDoc](https://typedoc.org/) — every exported
symbol, with its signature and TSDoc.

- **[`@btravstack/di`](/api/di/)** — `Port`, `Provider`, `Module`, `Context`,
  and the handful of type names (`AnyPort`, `ServiceOf`, `Scope`,
  `ScopedOptions`, `PortClass`, `ManyPortClass`) the public surface carries.

::: tip Looking for prose?
The generated pages document _signatures_. For what each member is **for**,
with worked examples, read the hand-written [Reference](/reference/ports); for
_why_ the surface is shaped this way, read the
[Explanation](/explanation/why-di).
:::

## The shape of the surface

Four values and six types — the whole of it:

```ts
import { Module, Port, Provider, Context } from "@btravstack/di";
import type {
  AnyPort,
  ManyPortClass,
  PortClass,
  Scope,
  ScopedOptions,
  ServiceOf,
} from "@btravstack/di";
```

Operations hang off the values by convention — `Port.many`, `Provider.member`,
`Module.build`, `Module.scoped`, `Module.forkScope`, `Context.empty` — so the
import list stays this short. `Scope` is deliberately a **type-only** export
([why](/reference/ports#scope-type-only)), and `PortClass`/`ManyPortClass`
exist for consumers' declaration emit, not for hand-written code. Everything
else — the build pipeline, the scope machinery, the internal type helpers — is
implementation detail, not exported.
