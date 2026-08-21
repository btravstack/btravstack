---
"@btravstack/contract": minor
"@btravstack/di": minor
"@btravstack/config": minor
"@btravstack/core": minor
"@btravstack/testing": minor
"@btravstack/observability": minor
"@btravstack/http": minor
"@btravstack/temporal": minor
"@btravstack/amqp": minor
---

A module declares what it expects from outside

`Module(name)({ … })` takes a fourth list, `needs`, and a port the module
depends on but neither provides nor imports must be named there. Anything it
owes and does not name is refused at that call, with the port in the message:

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

`Scope` is exempt — nothing can provide it, and the entry point discharges it.
`Env` is not: every module that reads the environment says `needs: [Env]`, and
so does every module that imports one, up to the root `start` hands one to.

The three starter sugars — `HttpModule`, `AmqpModule`, `TemporalModule` — take
`needs` too and re-declare the gate over their augmented tuples, so a
composition root written with a sugar is checked exactly like a bare
`Module(name)`.

`@btravstack/di` additionally exports `NeedsGate` and `Unmet`, which a package
offering its own shaped module needs in order to re-declare the gate.
