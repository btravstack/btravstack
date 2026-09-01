---
"@btravstack/http-server": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
---

The three servers record RED metrics. Each runtime now counts and times its own
unit — `btravstack.http.{requests,duration}` by method, answerer and status;
`btravstack.amqp.{deliveries,duration}` by handler and outcome;
`btravstack.temporal.activity.{attempts,duration}` by activity and outcome — on
the `Meter` port, on by default.

**Breaking for a root that composes no OTel SDK**: `instrumented` defaults to
`true`, which puts `Meter` in the starter's needs. Pass
`instrumented: false` to drop it — no meter, no instrument built, one `if` on
the request path.
