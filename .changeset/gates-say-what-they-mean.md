---
"@btravstack/core": minor
"@btravstack/amqp": minor
"@btravstack/temporal": minor
"@btravstack/http": minor
"@btravstack/testing": minor
---

The compile-time gates name what is missing. `start`'s markers rode a phantom
rest tuple, whose failure is an arity error — and arity errors never print
types, so `NO RUNTIME` never reached a reader and TypeScript's related info
pointed at the wrong fix. They ride the module parameter now.

`start`, `runMain` and `bootFixture` no longer take the trailing gate argument.
No production call site passed one; the documented hand-spelled bypass went
with it, so this is a signature change without a migration.

The same widening reached the composers: `AmqpHandlers`'s/`TemporalActivities`'s
`UNCOVERED HANDLERS`/`UNCOVERED ACTIVITIES` marker and `HttpRouter`'s
`UNDECLARED KEY` marker now say the rule in English and name the missing key,
where each used to end on a bare `"UNCOVERED HANDLERS"` or `never`.
