---
"@btravstack/core": minor
---

An unmet need at `start` is diagnosed in di's own words, and names the port.

`start`'s `module` parameter was `Module<X, E, Scope | Env>`, so a root that
imports `http()` and forgets `provides: [router]` failed on plain
assignability:

```text
Type 'HttpRouterPort' is not assignable to type 'Scope'.
  Types of property '[ID]' are incompatible.
    Type '"HttpRouter"' is not assignable to type '"@di/Scope"'.
```

`@di/Scope` is an internal phantom a reader has never heard of. Worse, when the
port was missing from `exports` too, the marker that fired was `UNSATISFIED
RUNTIME PORTS` — a correct diagnosis of the second mistake that reads as a wrong
one of the first, steering the fix into `exports` when it belongs in `provides`.

`StartGate` now takes the module's needs as a third parameter and checks them
**first**, in the sentence di's own entry points print:

```text
error TS2345: Argument of type 'Module<any, ConfigInvalid, Env | OrpcRouterPort>' is not assignable to parameter of type 'Module<any, ConfigInvalid, Env | OrpcRouterPort> & { readonly "UNSATISFIED DEPENDENCIES — nothing provides": "OrpcRouter"; }'.
```

The port is named by its **id**, not by its type: `AmqpHandlers` as a type is
its contract expanded — hundreds of characters of the caller's own schema,
truncated long before a name is reached — where `"AmqpHandlers"` is what the
application wrote in `Port("…")` and always fits. Several unmet ports print as
a union (`"Logger" | "Mailer"`).

`start`, `runMain` and `@btravstack/testing`'s `Boot` all gain the type
parameter; every call site infers it, so no caller changes.

Closes #203.
