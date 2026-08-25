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

A module declares what its own providers expect from outside

`Module(name)({ … })` takes a fourth list, `needs`. A port **this module's own
providers** read, and that nothing here satisfies, must be named there; anything
they owe and it does not name is refused at that call, with the port in the
message:

```
Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
  '{ provides: [...]; exports: [...]; }' but required in type
  '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
```

Before this, a need nothing local satisfied simply travelled to whoever
composed the module, and a composition root could satisfy an imported module's
dependency without that module ever mentioning it — measured: a slice's
provider received the root's service while importing nothing at all. A slice
directory could not be read on its own.

`needs` is the explicit stand-in for NestJS's `@Global`, which this container
does not have and now does not need: the port is named, the supplier is not, so
the slice still composes into any root that answers it.

**An import's own needs are not the importer's to re-declare.** They are already
published in the import's type, and the entry point still refuses a root that
has not discharged them — so the declaration lands on the feature that reads the
port, once, rather than on every module between it and the root. That is
`ConfigModule.forFeature`'s shape reached without a global: `DatabaseModule`
says `needs: [Env]` because it reads `DATABASE_URL`, and the persistence modules
and slices that import it say nothing.

`Scope` is exempt — nothing can provide it, and the entry point discharges it.

The three starter sugars — `HttpModule`, `AmqpModule`, `TemporalModule` — take
`needs` too and re-declare the gate over their augmented tuples, so a
composition root written with a sugar is checked exactly like a bare
`Module(name)`.

`@btravstack/di` additionally exports `NeedsGate` and `Unmet`, which a package
offering its own shaped module needs in order to re-declare the gate.
