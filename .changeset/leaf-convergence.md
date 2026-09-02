---
"@btravstack/amqp-worker": minor
"@btravstack/temporal-worker": minor
---

The handler and activity leaves take **one record** — everything the invocation
carries, the input included — matching oRPC, which is what an HTTP controller
here has always taken. Moving a use case between the three transports no longer
means relearning the function you type.

```ts
place:   ({ errors, context, input })      => …   // HTTP, unchanged
place:   ({ errors, context, input })      => …   // Temporal
process: ({ errors, context, raw, input }) => …   // AMQP
```

The convergence happened upstream — btravstack/temporal-contract#415 and
btravstack/amqp-contract#671 — so this bumps both peers to their new betas
(`@temporal-contract/*@8.0.0-beta.7`, `@amqp-contract/*@3.0.0-beta.7`) and moves
the examples and documentation with them. `input` is the field name on all
three; a local synonym per transport would put the relearning back on the one
field every leaf touches. The positional second parameter survives, because
oRPC has it too: `({ errors }, input)` is the same call.

Two behaviour changes ride along, both from the AMQP library:

- **An unreachable broker is a modeled `ConnectionError`** (amqp-contract#645),
  so `@btravstack/amqp-worker` NAMES it and maps it to `RuntimeStartFailed` —
  `runMain` exit `1`. The blanket `.recoverDefect(...)` that used to stand there
  is gone, and with it the behaviour that reported a genuine startup bug as the
  same modeled error. A bug now stays a defect and exits `70`.
- **A topology the broker refuses fails `create()`** (amqp-contract#675) instead
  of handing back a worker whose queues do not exist. It arrives as a defect,
  which is exit `70`: a queue declaration the broker rejects is a broken
  contract, not an operator's business.

Closes #207.
