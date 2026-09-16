---
"@btravstack/core": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
---

Gave a runtime a way to say it has stopped, routed the AMQP library's own
diagnostics somewhere, and corrected what the drain's reports mean.

**`Serving.stopped` is the channel for "nobody asked me to".** Optional, so no
shipped runtime had to change. A runtime had no way to report that it had given
up, and the lifecycle only ever moved on a signal or a `stop()` call — so a
Temporal worker whose `run()` rejected mid-flight left the process alive with
`/readyz` answering `200`, a pod in a Service's endpoints consuming nothing. The
kernel races the channel against its own shutdown and reports
`reason: "runtimeStopped"`. A runtime that implements it must **withdraw** after
a stop the kernel asked for, or it races every clean shutdown.

`@btravstack/temporal-worker` wires it. `@btravstack/amqp-worker` does not:
`@amqp-contract/worker` reports a server-initiated consumer cancel as a log line
and exposes no signal to race. That is stated as a gap rather than papered over.

**The AMQP starter passes the library a logger, as `Observers` operations.** It
was given none, so every diagnostic was discarded — a consumer the server
cancelled, a poison delivery, a spent retry budget, a failed retry publish, a
channel error. A poison delivery matters most: the library nacks it before the
handler middleware runs, so the `delivery` operation and the `outcome` dimension
never saw one, and a poison stream presented as a perfectly healthy worker
beside a filling dead-letter queue. `warn` and `error` become
`component: "amqp"`, `name: "broker"` operations; `debug` and `info` are dropped,
since an observer writes no line for a successful operation anyway.

**Four claims that a `RetryableError` leaves the delivery un-acked were wrong.**
Measured against `@amqp-contract/worker@3.0.0-beta.7`: it **acks** the original
and republishes a copy carrying `x-retry-count + 1`. Only a quorum queue in
`immediate-requeue` mode nacks with `requeue: true`. So the recommended
drain-abort arm spends one retry per in-flight message, and a rollout can
dead-letter work that nothing was wrong with. `prefetch` unset is `10`, not
uncapped, which two pages also had wrong.

**`abandoned` means "no longer awaited", not "did not finish", and the process
may not end by itself.** The kernel stops waiting and cannot cancel; the
transport keeps running and usually completes. That same transport holds the
event loop open, and `runMain` never calls `process.exit()`, so an abandoned
drain ends at Kubernetes' `terminationGracePeriodSeconds` with SIGKILL — exit `2`
is what the report says rather than what the orchestrator observes. Four pages
claimed a self-exit. Forcing the transport shut was declined: destroying an AMQP
connection under an ack in flight loses that ack.
