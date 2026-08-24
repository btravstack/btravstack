---
"@btravstack/di": minor
"@btravstack/testing": minor
---

The last mute diagnostics speak. `Module.build`, `Module.scoped` and
`Module.forkScope` gate unmet dependencies with `DependencyGate`, a marker
intersected onto the `module` parameter, and `tapped` gates an unexported
port with `TapGate` on its `ports` array — replacing the conditional rest
tuples whose failure was a bare arity line (`Expected 3 arguments, but got
1.`) that named neither the label nor the port. The message now ends on what
is missing: `required in type '{ readonly "UNSATISFIED DEPENDENCIES — nothing
provides": Cfg; }'`. Every gate a composing application meets is now the same
marker mechanism, and every one prints a name. The phantom rest arguments are
gone from the signatures; nothing could ever pass values for them.
